# fitten-code-2api

一个将 Fitten Code 聊天请求转换为 OpenAI Chat Completions 风格接口的轻量代理服务。

## 特性

- 提供 `/v1/models` 和 `/v1/chat/completions` 兼容接口
- 内置 Web UI 聊天界面（访问 `http://localhost:3000` 即可使用）
- 支持非流式响应
- 支持 SSE 流式响应
- 支持 `messages[].content` 字符串与分段数组输入
- 支持单张图片输入
- 支持 tool_calls / function calling 协议转换（上游 XML `<function_calls>` → OpenAI 标准 `tool_calls`）
- 统一错误结构，便于调用方处理

## 当前能力边界

- 已支持：文本输入、流式输出、内容分段数组、单图输入
- 已支持：上游 XML `<function_calls>` 自动转换为 OpenAI 标准 `tool_calls`（非流式 + 流式增量格式）
- 已支持：请求体中的 `assistant.tool_calls` 与 `role: "tool"` 消息整理进聊天输入
- 明确不支持：同一条消息中的多图输入
- 暂未实现：代理自己发起并执行 tools / function calling（2api 只做协议转换，执行由接入方 agent 完成）
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

## Web UI 聊天界面

项目内置了一个轻量级的 Web UI 聊天界面，启动服务后可以直接在浏览器中使用：

- 访问地址：`http://localhost:3000`
- 支持流式输出显示
- 支持多轮对话
- 支持设置 API 地址、API Key、温度参数等
- 对话记录保存在浏览器本地存储

适合快速测试和调试 API 接口，也可以作为简单的聊天客户端使用。

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

### 3. 带 tool_calls 的非流式请求

```http
POST /v1/chat/completions
Content-Type: application/json

{
  "model": "fitten-code",
  "messages": [
    { "role": "system", "content": "你是助手" },
    { "role": "user", "content": "帮我查一下当前目录" }
  ],
  "stream": false
}
```

如果上游返回 XML `<function_calls>`，2api 会自动转成 OpenAI 标准 `tool_calls` 格式：

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "我来帮你查一下。",
      "tool_calls": [{
        "index": 0,
        "id": "xml_tool_call_xxx_0",
        "type": "function",
        "function": {
          "name": "run_terminal",
          "arguments": "{\"command\":\"ls -la\"}"
        }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

### 4. 带 tool_calls 的流式请求

流式请求同样支持 tool_calls 转换。当上游返回 XML `<function_calls>` 时，最后一个 SSE chunk 的 `finish_reason` 为 `tool_calls`，并包含 `tool_calls` 字段：

```json
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"xml_tool_call_xxx_0","type":"function","function":{"name":"run_terminal","arguments":"{\"command\":\"ls -la\"}"}}]},"finish_reason":"tool_calls"}]}
```

### 5. 单图输入请求

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

当前版本已知限制如下：

- 当前只实现 `GET /v1/models` 和 `POST /v1/chat/completions`
- 默认会在缺失 system message 时自动补一条 `请完全使用中文回答。`
- 不支持同一条消息中的多图输入
- 不支持 embeddings
- 不支持文件上传
- 不支持跨实例共享会话缓存；当前 session cache 为进程内内存缓存
- `scripts/check-*.js` 主要是本地联调脚本，不属于离线可重复的单元测试
- 不支持代理自己发起和执行 tools / function calling（2api 只做协议转换，执行由接入方 agent 完成）

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

仓库提供了一组本地联调脚本，主要用于回归聊天主链路、图片边界与 tool_calls 协议转换。常用命令：

```bash
npm test
npm run check:proxy
npm run check:stream
npm run check:tool-calls
npm run check:content-array
npm run check:markdown
npm run check:newlines
npm run check:errors
npm run check:image-input
npm run check:image-stream
npm run check:image-cleanup
npm run check:image-boundaries
npm run check:all
```

其中 `npm test` 当前主要做基础语法检查，已经覆盖 [`index.js`](index.js:1)、[`src/openai-request.js`](src/openai-request.js:1)、[`src/message-content.js`](src/message-content.js:1)、[`src/streaming.js`](src/streaming.js:1)、[`src/tool-calls.js`](src/tool-calls.js:1)、[`src/inputs.js`](src/inputs.js:1)、[`src/helpers.js`](src/helpers.js:1)、[`src/fitten-payloads.js`](src/fitten-payloads.js:1)、[`src/session.js`](src/session.js:1)、[`src/errors.js`](src/errors.js:1) 和 [`src/parse-xml-tool-calls.js`](src/parse-xml-tool-calls.js:1)。

脚本分类说明：

**基础功能测试：**
- [`check-proxy.js`](scripts/check-proxy.js:1)：基础代理功能测试
- [`check-stream.js`](scripts/check-stream.js:1)：流式输出测试
- [`check-tool-calls.js`](scripts/check-tool-calls.js:1)：XML `<function_calls>` → OpenAI `tool_calls` 协议转换（非流式 + 流式）
- [`check-content-array.js`](scripts/check-content-array.js:1)：内容分段数组输入测试
- [`check-markdown.js`](scripts/check-markdown.js:1)：Markdown 格式处理测试
- [`check-newlines.js`](scripts/check-newlines.js:1)：换行符处理测试
- [`check-errors.js`](scripts/check-errors.js:1)：错误码测试

**图片相关测试：**
- [`check-image-input.js`](scripts/check-image-input.js:1)：单图输入测试
- [`check-image-stream.js`](scripts/check-image-stream.js:1)：流式图片响应测试
- [`check-image-cleanup.js`](scripts/check-image-cleanup.js:1)：图片清理逻辑测试
- [`check-image-boundaries.js`](scripts/check-image-boundaries.js:1)：图片边界条件测试
- [`check-image-size-limit.js`](scripts/check-image-size-limit.js:1)：图片大小限制测试
- [`check-multi-image-rejected.js`](scripts/check-multi-image-rejected.js:1)：多图输入拒绝测试
- [`check-invalid-image-data-url.js`](scripts/check-invalid-image-data-url.js:1）：无效 Base64 图片数据测试
- [`check-unsupported-image-url.js`](scripts/check-unsupported-image-url.js:1）：不支持的 URL 格式测试

**远程图片测试：**
- [`check-remote-image.js`](scripts/check-remote-image.js:1）：远程图片拉取测试
- [`check-remote-image-size-limit.js`](scripts/check-remote-image-size-limit.js:1）：远程图片大小限制测试
- [`check-remote-image-not-image.js`](scripts/check-remote-image-not-image.js:1）：远程 URL 非图片内容测试
- [`check-remote-image-empty.js`](scripts/check-remote-image-empty.js:1）：远程图片空响应测试

这些脚本依赖真实的 Fitten 凭据和外部网络环境，适合作为本地集成验证。

## 项目结构

```text
.
├─ index.js                  入口：路由定义、请求重试与响应组装
├─ package.json
├─ README.md
├─ public/                   Web UI 聊天界面
│  ├─ index.html             主页面
│  ├─ app.js                 前端逻辑
│  └─ style.css              样式文件
├─ src/
│  ├─ errors.js              公共错误
│  ├─ fitten-payloads.js     上游请求载荷与元数据构建
│  ├─ helpers.js             工具函数
│  ├─ inputs.js              Fitten 输入格式与工具描述构建
│  ├─ message-content.js     消息归一化与图片处理
│  ├─ openai-request.js      OpenAI 请求解析
│  ├─ parse-xml-tool-calls.js XML <function_calls> 解析器
│  ├─ session.js             会话管理与 token 刷新
│  ├─ streaming.js           流式响应处理
│  └─ tool-calls.js          OpenAI tool_calls 格式转换
└─ scripts/
   └─ check-*.js             本地联调脚本
```
