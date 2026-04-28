# DEVELOPMENT.md

## 项目定位

`fitten-code-2api` 是一个主链路聚焦 `POST /v1/chat/completions` 的轻量代理，并提供基础的健康检查与模型列表接口：

1. 接收 OpenAI 风格请求
2. 清洗并归一化消息内容
3. 登录 Fitten 并复用会话
4. 把请求转换成 Fitten 当前 Web 端聊天协议
5. 将上游普通响应或 NDJSON 流重新包装成 OpenAI 风格结果

它的目标不是完整复刻 OpenAI API，而是稳定打通当前最常用的聊天主链路。

## 模块结构

```
index.js                  入口：路由定义、请求重试与响应组装
src/
  agent-mode.js           XML Function Calling 支持
  errors.js               公共错误：createHttpError / normalizeError
  helpers.js              工具函数：fetchWithTimeout / parseJsonResponse / buildBrowserHeaders 等
  message-content.js      消息归一化与图片处理：cleanMessages / ensureDefaultSystemMessage
  openai-request.js       OpenAI 请求解析：buildOpenAiRequest
  session.js              会话管理：登录 / token 刷新 / 内存缓存
  streaming.js            流式响应：SSE 事件写入 / 上游 ndjson 解析 / 客户端断连检测
  tool-calling.js         Tool 响应构建：buildToolCall / buildToolCallsResponse / formatAssistantToolCallsMessage
```

## 运行入口

服务入口在 `index.js`：

- `GET /`：健康检查
- `GET /v1/models`：返回当前可用模型列表
- `POST /v1/chat/completions`：聊天代理主入口

启动后，服务会从环境变量读取运行参数，例如端口、上游地址、默认模型、超时时间、图片大小限制等。

## 主请求链路

`POST /v1/chat/completions` 的处理顺序大致如下：

1. `buildOpenAiRequest(body)`
   - 读取 `model`、`messages`、`stream`、`stream_options`、`tools`、`tool_choice`
   - 兼容部分别名字段，例如 `prompt`、`input`、`modelName`
2. `getMessages(body)`
   - 统一把输入整理成消息数组
   - 如果没有 system message，会补一条默认中文 system prompt
3. `cleanMessages(items)` / `normalizeMessageContent(content)`
   - 清理非法消息
   - 把字符串或 content part 数组统一归一化
   - 支持 `tool` 角色：工具执行结果转成文本格式
   - 支持 `assistant` + `tool_calls`：工具调用转成文本格式
4. `getFittenCredentials()`
   - 从环境变量 `FITTEN_USERNAME` / `FITTEN_PASSWORD` 读取账号密码
5. `getFittenSession(credentials)`
   - 先查进程内缓存
   - 无可用 session 时重新登录
6. 根据是否有 tools 分流：
   - 有 tools：使用 `buildAgentPayload` 构建 XML 格式请求
   - 无 tools：使用 `buildFittenInputs` 构建普通请求
7. 根据 `stream` 分流：
   - 非流式：`sendChatWithRetry(...)`
   - 流式：`sendChatStreamWithRetry(...)`
8. 统一走 `normalizeError(error)` 返回 OpenAI 风格错误结构

## 消息归一化

当前实现接受两类 `messages[].content`：

- 普通字符串
- OpenAI 风格内容分段数组

已处理的 part 类型主要有：

- `text`
- `input_text`
- `output_text`
- `input_image`
- `image_url`

相关函数：

- `normalizeMessageContent`
- `normalizeContentPart`
- `buildStructuredMessageContent`
- `joinContentParts`

### 默认 system prompt

如果调用方没有提供 `role=system` 的消息，服务会自动补：

- `请完全使用中文回答。`

这属于当前实现的默认行为，不是 OpenAI 官方协议要求。

## 图片输入处理

图片链路集中在这些函数：

- `normalizeImagePart`
- `extractImageUrl`
- `ensureDataImageWithinLimit`
- `convertRemoteImageToDataUrl`

当前规则：

- 单条消息最多只允许一张图片
- 支持 `data:image/...;base64,...`
- 支持远程 `http/https` 图片 URL
- 远程图片会先抓取，再转成 data URL 嵌入文本内容
- 图片超过 `MAX_IMAGE_BYTES` 会直接报错

归一化后，图片会被转成 Markdown 图片语法并参与上游 `inputs` 拼接。

## Fitten 请求格式

当前主链路发往上游的是：

- 登录：`POST /codeuser/auth/login`
- 刷新 access token：`POST /codeuser/auth/refresh_access_token`
- 聊天：`POST /codeapi/chat_auth?apikey=<userId>`

聊天请求体形态为：

**普通聊天（无 tools）：**
```json
{
  "inputs": "<|system|>...<|end|>\n<|user|>...<|end|>\n<|assistant|>\n",
  "ft_token": "<userId>"
}
```

**Agent 聊天（有 tools）：**
```json
{
  "inputs": "<|system|>\n# 工具使用指南\n...\n<|end|>\n<|user|>...<|end|>\n<|assistant|>",
  "ft_token": "<userId>",
  "mode": "agent"
}
```

其中 `inputs` 由 `buildFittenInputs(messages)` 或 `buildXMLInputs(...)` 生成。

## Session 与 token 管理

当前会话层是一个**进程内内存缓存**：

- `sessionCache = new Map()`
- key 使用 `username`
- value 保存 `accessToken`、`refreshToken`、`userId`、过期时间和部分用户信息

关键函数：

- `getFittenSession`
- `loginToFitten`
- `isSessionUsable`
- `ensureValidAccessToken`
- `refreshSessionTokens`
- `updateSessionTokens`
- `clearCachedSession`

处理策略：

1. 优先复用未过期 access token
2. access token 临近过期时，用 refresh token 刷新
3. refresh 失败后，清缓存并重新登录

### 当前局限

- session cache 不持久化
- 多实例之间不共享
- 服务重启后会丢失缓存

所以它更适合单实例工具型部署，而不是水平扩展场景。

## XML Function Calling

本代理使用 XML 格式与 Fitten Code 进行 function calling 交互。

核心模块在 `src/agent-mode.js`：

- `buildAgentPayload(messages, tools, session, options)` — 构建 XML function calling 的 payload
- `buildXMLToolsPrompt(tools)` — 构建 XML 格式的 tools 提示词
- `buildXMLInputs(systemPrompt, userInput, allMessages)` — 构建 XML 格式的 inputs
- `parseToolCallXML(content)` — 解析 XML 格式的工具调用
- `isToolCallFormat(content)` — 检测是否是工具调用格式
- `parseAgentResponse(events, tools)` — 解析 Agent 响应

核心模块在 `src/tool-calling.js`：

- `buildToolCall(name, args)` — 构建 OpenAI 格式的 tool_call 对象
- `buildToolCallsResponse(...)` — 构建 OpenAI 格式的 tool_calls 响应
- `formatAssistantToolCallsMessage(message)` — 把 assistant + tool_calls 消息转成 XML 文本
- `formatToolResultMessage(item)` — 把 tool 角色消息转成 XML 文本

### 工作流程

1. 请求携带 `tools` 参数时，`buildAgentPayload` 调用 `buildXMLToolsPrompt` 生成 XML 格式工具描述
2. 工具描述作为 system prompt 注入
3. Fitten 模型输出中如果包含 `<function_calls>...</function_calls>` XML 标签，则解析为 tool_calls
4. 非流式响应：`index.js` 中直接检查并转换
5. 流式响应：`pipeAgentStream` 处理 XML 格式的流式输出

### XML 格式

**工具提示词格式：**
```xml
# 工具使用指南

## tool_name
工具描述

参数：
- param1: string（必需）

## 使用格式

当你需要使用工具时，请按以下 XML 格式输出：

<function_calls>
<invoke name="use_tool">
<parameter name="tool_name">工具名称</parameter>
<parameter name="arguments">{"key": "value"}</parameter>
</invoke>
</function_calls>
```

**模型响应格式：**
```xml
<function_calls>
<invoke name="use_tool">
<parameter name="tool_name">get_weather</parameter>
<parameter name="arguments">{"city":"北京"}</parameter>
</invoke>
</function_calls>
```

**工具结果格式：**
```xml
<function_results>
工具执行结果内容
</function_results>
```

### 局限

- 模型对 prompt 指令的遵循程度决定了工具调用的可靠性
- 流式模式下需要收集完整输出才能判断，首包延迟高于普通流式

## 非流式响应链路

非流式主链路：

- `sendChatWithRetry`
- `sendChatRequest`
- `openChatRequest`
- `parseFittenEvents`
- `buildOpenAiResponse`

处理方式：

1. 先确保 access token 可用
2. 请求 Fitten 聊天接口
3. 读取完整 NDJSON 文本
4. 逐行解析成事件数组
5. 聚合 `delta`
6. 提取 usage 信息
7. 返回标准 OpenAI chat completion JSON

## 流式响应链路

流式主链路：

- `sendChatStreamWithRetry`
- `sendChatStreamRequest`
- `openChatRequest`
- `pipeFittenStreamAsOpenAi`
- `writeOpenAiContentChunk`
- `finishOpenAiStream`

处理方式：

1. 发起上游聊天请求
2. 直接读取上游返回体 `ReadableStream`
3. 按行拆分 NDJSON 事件
4. 把每个上游事件重新包装成 OpenAI SSE chunk
5. 最后补 `finish_reason=stop`、可选 usage、`[DONE]`

### 流式细节

- 返回头会设置为 `text/event-stream`
- 显式关闭缓存和代理缓冲
- 每次写入后会尝试 `flush`
- 客户端断开连接时会中止上游请求
- 上游如果没有真正返回流体，也会回退到整包解析后再按流式格式下发
### 内容整形

为了减少极碎的 token 片段直接打到下游，流式链路会有一个轻量缓冲：

- `pendingContent` 先暂存内容
- 达到一定长度或命中自然边界时再 flush

这部分逻辑由这些函数控制：

- `normalizeStreamDelta`
- `shouldFlushStreamContent`
- `flushPendingContent`

目标是让下游看到的流更平滑，但不改变最终文本内容。

## 错误处理

统一错误出口：

- `createHttpError(...)`
- `normalizeError(error)`

常见错误来源：

- 输入消息不合法
- 图片 URL 或 base64 非法
- Fitten 登录失败
- refresh token 失效
- 上游返回非法 JSON
- 上游请求超时
- 客户端提前断开

最终都会尽量被整理成：

```json
{
  "error": {
    "message": "...",
    "type": "invalid_request_error",
    "code": "...",
    "param": null
  }
}
```

## 验证脚本

仓库里的 `scripts/check-*.js` 主要用于本地联调回归，例如：

- 代理主链路
- 流式输出
- refresh 流程
- content array 兼容
- 图片边界条件

这些脚本依赖：

- 真实 Fitten 账号
- 真实网络环境
