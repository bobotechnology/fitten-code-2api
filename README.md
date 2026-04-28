# fitten-code-2api

一个将 Fitten Code 聊天请求转换为 OpenAI Chat Completions 风格接口的轻量代理服务。

## 特性

- 提供 `/v1/models` 和 `/v1/chat/completions` 兼容接口
- 支持非流式响应
- 支持 SSE 流式响应
- 支持 `messages[].content` 字符串与分段数组输入
- 支持单张图片输入
- 支持 tools / function calling（XML 格式）
- 统一错误结构，便于调用方处理

## 当前能力边界

当前版本聚焦在聊天主链路：

- 已支持：文本输入、流式输出、内容分段数组、单图输入、tools/function calling
- 明确不支持：同一条消息中的多图输入
- 暂未实现：embeddings 等扩展能力

当同一条消息包含多张图片时，服务会返回：

- HTTP 400
- `error.code = "multiple_images_not_supported"`

## 安装

```bash
npm install
```

## 启动

先复制环境变量示例文件，再填入自己的 Fitten 账号凭据：

```bash
# Linux / macOS
cp .env.example .env

# Windows
copy .env.example .env
```

编辑 `.env`，填入 `FITTEN_USERNAME` 和 `FITTEN_PASSWORD`，然后启动：

```bash
npm start
```

默认监听地址：`http://localhost:3000`

## 环境变量

完整示例见 `.env.example`。

- `PORT`：服务端口，默认 `3000`
- `FITTEN_BASE_URL`：Fitten 服务地址，默认 `https://fc.fittenlab.cn`
- `DEFAULT_MODEL`：默认模型名，默认 `fitten-code`
- `FITTEN_USER_AGENT`：上游请求使用的 User-Agent；留空时使用内置浏览器 UA
- `FITTEN_REQUEST_TIMEOUT_MS`：上游请求超时，默认 `120000`
- `FITTEN_ACCESS_TOKEN_REFRESH_MARGIN_MS`：access token 提前续期窗口，默认 `60000`
- `MAX_IMAGE_BYTES`：单张图片大小上限，默认 `5MB`
- `FITTEN_USERNAME`：Fitten 登录账号
- `FITTEN_PASSWORD`：Fitten 登录密码

## 接口

### 健康检查

```http
GET /
```

### 模型列表

```http
GET /v1/models
```

返回当前可用模型列表（标准 OpenAI 格式）：

```json
{
  "object": "list",
  "data": [
    {
      "id": "fitten-code",
      "object": "model",
      "created": 1700000000,
      "owned_by": "fitten"
    }
  ]
}
```

### 聊天接口

```http
POST /v1/chat/completions
Content-Type: application/json
```

## 请求示例

### 1. 非流式文本请求

```json
{
  "model": "fitten-code",
  "messages": [
    {
      "role": "system",
      "content": "请完全使用中文回答。"
    },
    {
      "role": "user",
      "content": "你好，请只回复 ok"
    }
  ],
  "stream": false
}
```

### 2. 流式文本请求

```json
{
  "model": "fitten-code",
  "messages": [
    {
      "role": "user",
      "content": "请分三行介绍一下这个代理的作用"
    }
  ],
  "stream": true,
  "stream_options": {
    "include_usage": true
  }
}
```

### 3. 单图输入请求

```json
{
  "model": "fitten-code",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "请描述这张图片里的主要内容"
        },
        {
          "type": "input_image",
          "image_url": {
            "url": "https://example.com/demo.png"
          }
        }
      ]
    }
  ],
  "stream": false
}
```

如果单条消息里同时放入多张图片，服务会直接返回 `multiple_images_not_supported`。

## 响应说明

服务会先完成 Fitten 登录和会话准备，再将请求转换后发送到上游聊天接口，最后返回 OpenAI 风格响应。

非流式返回结构示例：

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1710000000,
  "model": "fitten-code",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "ok"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 94,
    "completion_tokens": 2,
    "total_tokens": 96
  }
}
```

当 `stream: true` 时，返回 OpenAI 风格的 SSE 数据流。

## 图片输入

图片输入仅支持单张图片，接受以下格式：

- `data:image/...;base64,...`
- `http://...`
- `https://...`

限制说明：

- 单条消息最多一张图片
- 单张图片默认不超过 `5MB`
- 非图片内容、空响应或不支持的协议会返回明确错误码

## Tools / Function Calling

本代理使用 XML 格式与 Fitten Code 进行 function calling 交互。

### 工作原理

1. 请求中携带 `tools` 参数时，代理会把工具定义转成 XML 格式注入 system prompt
2. 模型决定调用工具时，输出 XML 格式的 `<function_calls>` 标签
3. 代理解析 XML 输出，转换成标准 OpenAI `tool_calls` 格式返回

### 请求示例

```json
{
  "model": "fitten-code",
  "messages": [
    { "role": "user", "content": "北京今天天气怎么样？" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "获取指定城市的天气信息",
        "parameters": {
          "type": "object",
          "properties": {
            "city": { "type": "string", "description": "城市名称" }
          },
          "required": ["city"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "stream": false
}
```

`tool_choice` 支持以下取值：

- `"auto"`：由模型决定是否调用工具（默认）
- `"required"`：必须调用至少一个工具
- `"none"`：不调用工具，等同普通对话
- `{ "type": "function", "function": { "name": "..." } }`：强制调用指定工具

### 响应示例

当模型决定调用工具时，返回 `finish_reason: "tool_calls"`：

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1710000000,
  "model": "fitten-code",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_xxxxxxxxxxxxxxxxxxxxxxxx",
            "type": "function",
            "function": {
              "name": "get_weather",
              "arguments": "{\"city\":\"北京\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

### 回传工具结果

拿到 `tool_calls` 后，调用方执行工具并把结果回传：

```json
{
  "model": "fitten-code",
  "messages": [
    { "role": "user", "content": "北京今天天气怎么样？" },
    { "role": "assistant", "content": null, "tool_calls": [
      { "id": "call_xxx", "type": "function", "function": { "name": "get_weather", "arguments": "{\"city\":\"北京\"}" } }
    ]},
    { "role": "tool", "tool_call_id": "call_xxx", "content": "{\"temperature\": 25, \"condition\": \"晴\"}" }
  ],
  "stream": false
}
```

### 注意事项

- 这是 XML 格式模拟，可靠性取决于模型对指令的遵循程度
- 流式模式下，代理会先收集完整输出再判断是否包含工具调用，因此首包延迟会比普通流式响应更高
- `tool_choice: "none"` 等同于不传 `tools`，代理不会注入工具定义

当前版本有意保持在较窄的兼容范围内，已知限制如下：

- 当前只实现 `GET /v1/models` 和 `POST /v1/chat/completions`
- 默认会在缺失 system message 时自动补一条 `请完全使用中文回答。`
- 不支持同一条消息中的多图输入
- 不支持 embeddings
- 不支持文件上传
- 不支持跨实例共享会话缓存；当前 session cache 为进程内内存缓存
- `scripts/check-*.js` 主要是本地联调脚本，不属于离线可重复的单元测试

## 常见错误码

服务会尽量返回统一的 OpenAI 风格错误结构：

```json
{
  "error": {
    "message": "...",
    "type": "invalid_request_error",
    "code": "image_too_large",
    "param": "messages.content.image_url"
  }
}
```

目前文档中明确列出的常见错误码包括：

- `multiple_images_not_supported`：同一条消息中出现多张图片
- `image_too_large`：图片超过 `MAX_IMAGE_BYTES` 限制
- `invalid_image_data_url`：`data:image/...` Base64 数据不合法
- `unsupported_image_url`：图片 URL 不是 `data:image/...` 或 `http/https`
- `remote_image_fetch_failed`：远程图片拉取失败
- `remote_image_not_image`：远程 URL 返回的内容不是图片
- `remote_image_empty`：远程图片响应为空
- `invalid_credentials`：Fitten 登录失败或账号密码无效
- `login_failed`：Fitten 登录接口返回了非预期失败
- `invalid_upstream_json`：上游返回了无法解析的 JSON
- `invalid_login_payload`：登录成功响应缺少必要字段
- `refresh_token_invalid`：refresh token 无效
- `refresh_user_not_found`：refresh token 对应用户不存在
- `refresh_access_token_failed`：刷新 access token 失败
- `refresh_token_unavailable`：当前 session 中没有可用 refresh token
- `upstream_timeout`：上游请求超时
- `client_closed_request`：客户端提前断开连接
- `upstream_unauthorized`：上游返回 401
- `upstream_request_failed`：上游请求返回非预期状态码
- `empty_upstream_response`：上游返回了空响应
- `internal_error`：服务内部错误
- `invalid_request`：请求参数不合法

## 验证脚本

仓库提供了一组本地联调脚本，主要用于回归聊天主链路、图片边界与性能表现。常用命令：

```bash
npm run check:proxy
npm run check:stream
npm run check:image-boundaries
npm run check:all
```

这些脚本依赖真实的 Fitten 凭据和外部网络环境，适合作为本地集成验证。

## 项目结构

```text
.
├─ index.js              入口：路由定义、请求重试与响应组装
├─ package.json
├─ README.md
├─ src/
│  ├─ agent-mode.js      XML Function Calling 支持
│  ├─ errors.js          公共错误
│  ├─ helpers.js         工具函数
│  ├─ message-content.js 消息归一化与图片处理
│  ├─ openai-request.js  OpenAI 请求解析
│  ├─ session.js         会话管理与 token 刷新
│  ├─ streaming.js       流式响应处理
│  └─ tool-calling.js    Tool 响应构建
└─ scripts/
   └─ check-*.js         本地联调脚本
```
