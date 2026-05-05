require('dotenv').config({ quiet: true });

const express = require('express');
const crypto = require('crypto');
const { normalizeError } = require('./src/errors');
const { FITTEN_BASE_URL, buildAuthorizedHeaders, fetchWithTimeout, normalizeUsage, buildUpstreamHttpError } = require('./src/helpers');
const { buildOpenAiRequest, getFittenCredentials, DEFAULT_MODEL } = require('./src/openai-request');
const { getFittenSession, clearCachedSession, ensureValidAccessToken, refreshSessionTokens, sessionCache } = require('./src/session');
const { parseFittenEvents, pipeFittenStreamAsOpenAi, createClientAbortController, writeOpenAiStreamError } = require('./src/streaming');
const { buildFittenChatPayload } = require('./src/fitten-payloads');
const { parseXmlToolCallsFromText, hasFunctionCalls, stripXmlToolCalls, hasJsonToolCall, parseJsonToolCallsFromText, parseTextToolCalls } = require('./src/parse-xml-tool-calls');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));

// ============================================
// 路由
// ============================================

app.get('/', (request, response) => {
  response.json({
    message: 'fitten code 2api is running',
    endpoints: ['/v1/models', '/v1/chat/completions']
  });
});

app.get('/v1/models', (request, response) => {
  response.json({
    object: 'list',
    data: [{
      id: DEFAULT_MODEL,
      object: 'model',
      created: 1700000000,
      owned_by: 'fitten'
    }]
  });
});

app.post('/v1/chat/completions', async (request, response) => {
  try {
    const body = request.body;
    const openaiRequest = await buildOpenAiRequest(body);

    if (!openaiRequest) {
      return response.status(400).json({
        error: {
          message: 'request body is empty or invalid',
          type: 'invalid_request_error'
        }
      });
    }

    const credentials = getFittenCredentials();
    if (!credentials.username || !credentials.password) {
      return response.status(400).json({
        error: {
          message: 'missing Fitten credentials, set FITTEN_USERNAME and FITTEN_PASSWORD environment variables',
          type: 'invalid_request_error'
        }
      });
    }

    const session = await getFittenSession(credentials, { forceLogin: false });

    // 检查 session 是否有效
    if (!session || !session.userId || !session.accessToken) {
      return response.status(500).json({
        error: {
          message: 'Failed to get valid session, please check credentials',
          type: 'server_error',
          code: 'session_error'
        }
      });
    }

    // 构建请求 payload
    const fittenPayload = buildFittenChatPayload(openaiRequest.messages, session, {
      inputs: buildFittenInputs(openaiRequest.messages, openaiRequest.tools)
    });

    if (openaiRequest.stream) {
      return await sendChatStreamWithRetry(response, openaiRequest, session, fittenPayload, credentials);
    }

    const fittenResult = await sendChatWithRetry(session, fittenPayload, credentials);

    // 拼接完整文本
    const content = fittenResult.events
      .map((event) => (typeof event.delta === 'string' ? event.delta : ''))
      .join('');

    return response.json(buildOpenAiResponse(openaiRequest.model, content, fittenResult.events));

  } catch (error) {
    const normalized = normalizeError(error);
    return response.status(normalized.statusCode).json({
      error: {
        message: normalized.message,
        type: normalized.type,
        code: normalized.code,
        param: normalized.param || null
      }
    });
  }
});

// ============================================
// 非流式请求
// ============================================

async function sendChatWithRetry(session, payload, credentials) {
  try {
    const readySession = await ensureValidAccessToken(session, credentials);
    return await sendChatRequest(readySession, payload, credentials);
  } catch (error) {
    if (error.statusCode !== 401) throw error;

    const cachedSession = credentials?.username ? sessionCache.get(credentials.username) : null;
    const baseSession = cachedSession || session;

    try {
      const refreshedSession = await refreshSessionTokens(baseSession, credentials);
      return await sendChatRequest(refreshedSession, payload, credentials);
    } catch {
      clearCachedSession(credentials);
      const freshSession = await getFittenSession(credentials, { forceLogin: true });
      return sendChatRequest(freshSession, payload, credentials);
    }
  }
}

async function sendChatRequest(session, payload, credentials) {
  const readySession = await ensureValidAccessToken(session, credentials);
  const response = await openChatRequest(readySession, payload);

  const text = await response.text();
  if (!response.ok) {
    if (response.status === 401) clearCachedSession(credentials);
    throw buildUpstreamHttpError(response.status, text, {
      type: response.status >= 500 ? 'server_error' : 'invalid_request_error',
      code: response.status === 401 ? 'upstream_unauthorized' : 'upstream_request_failed'
    });
  }

  const events = parseFittenEvents(text);
  return { raw: text, events };
}

// ============================================
// 流式请求
// ============================================

async function sendChatStreamWithRetry(response, openaiRequest, session, payload, credentials) {
  try {
    const readySession = await ensureValidAccessToken(session, credentials);
    return await sendChatStreamRequest(response, openaiRequest, readySession, payload, credentials);
  } catch (error) {
    if (error.statusCode !== 401) throw error;

    const cachedSession = credentials?.username ? sessionCache.get(credentials.username) : null;
    const baseSession = cachedSession || session;

    try {
      const refreshedSession = await refreshSessionTokens(baseSession, credentials);
      return await sendChatStreamRequest(response, openaiRequest, refreshedSession, payload, credentials);
    } catch {
      clearCachedSession(credentials);
      const freshSession = await getFittenSession(credentials, { forceLogin: true });
      return sendChatStreamRequest(response, openaiRequest, freshSession, payload, credentials);
    }
  }
}

async function sendChatStreamRequest(response, openaiRequest, session, payload, credentials) {
  const readySession = await ensureValidAccessToken(session, credentials);
  const clientAbort = createClientAbortController(response);

  try {
    const upstream = await openChatRequest(readySession, payload, { signal: clientAbort.signal });

    if (!upstream.ok) {
      const text = await upstream.text();
      if (upstream.status === 401) clearCachedSession(credentials);
      throw buildUpstreamHttpError(upstream.status, text, {
        type: upstream.status >= 500 ? 'server_error' : 'invalid_request_error',
        code: upstream.status === 401 ? 'upstream_unauthorized' : 'upstream_request_failed'
      });
    }

    return await pipeFittenStreamAsOpenAi(
      response,
      openaiRequest.model,
      upstream,
      {
        ...openaiRequest.stream_options,
        // 检测 XML/JSON/text tool calls 并转成 OpenAI tool_calls
        toolCallDetector(content) {
          let toolCalls = hasFunctionCalls(content) ? parseXmlToolCallsFromText(content) : [];
          if (toolCalls.length === 0 && hasJsonToolCall(content)) {
            toolCalls = parseJsonToolCallsFromText(content);
          }
          if (toolCalls.length === 0) {
            toolCalls = parseTextToolCalls(content);
          }
          if (!toolCalls.length) return null;
          return buildOpenAiToolCalls(toolCalls);
        }
      },
      clientAbort.signal
    );
  } catch (error) {
    if (clientAbort.signal.aborted) return;
    if (response.headersSent) {
      writeOpenAiStreamError(response, error);
      return;
    }
    throw error;
  } finally {
    clientAbort.cleanup();
  }
}

// ============================================
// 上游请求
// ============================================

async function openChatRequest(session, payload, options = {}) {
  // 防御性检查
  if (!session || !session.userId || !session.accessToken) {
    throw new Error('Invalid session: missing userId or accessToken');
  }

  const requestBody = {
    inputs: payload.inputs,
    ft_token: payload.ft_token || session.userId,
    meta_datas: payload.meta_datas
  };

  return fetchWithTimeout(`${FITTEN_BASE_URL}/codeapi/chat_auth?apikey=${encodeURIComponent(session.userId)}`, {
    method: 'POST',
    headers: buildAuthorizedHeaders(session.accessToken, {
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson, application/json, text/plain, */*'
    }),
    body: JSON.stringify(requestBody),
    signal: options.signal
  });
}

// ============================================
// 响应构建
// ============================================

// 构建 OpenAI 兼容响应，自动检测 XML/JSON/text tool calls 并转成 tool_calls
function buildOpenAiResponse(model, content, events) {
  const usageEvent = events.find((event) => event && typeof event.usage === 'object');

  // 检测 XML <function_calls> 并转成 OpenAI tool_calls
  let toolCalls = hasFunctionCalls(content) ? parseXmlToolCallsFromText(content) : [];

  // 回退：检测 JSON 工具调用
  if (toolCalls.length === 0 && hasJsonToolCall(content)) {
    toolCalls = parseJsonToolCallsFromText(content);
  }

  // 回退：检测 [tool_calls] 文本格式（Roo Code 风格）
  if (toolCalls.length === 0) {
    toolCalls = parseTextToolCalls(content);
  }

  const cleanContent = hasFunctionCalls(content) ? stripXmlToolCalls(content) : content;

  const message = { role: 'assistant', content: cleanContent || '' };
  if (toolCalls.length > 0) message.tool_calls = buildOpenAiToolCalls(toolCalls);

  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
    }],
    usage: normalizeUsage(usageEvent?.usage)
  };
}

// 把 XML tool calls 转成 OpenAI 标准 tool_calls 格式
function buildOpenAiToolCalls(toolCalls) {
  return toolCalls.map((toolCall, index) => ({
    index,
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.function.name,
      arguments: JSON.stringify(toolCall.function.arguments)
    }
  }));
}

// ============================================
// 工具函数
// ============================================

// 转义特殊标签，防止 prompt 注入
function escapeFittenTags(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<\|system\|>/gi, '<|system|>')
    .replace(/<\|user\|>/gi, '<|user|>')
    .replace(/<\|assistant\|>/gi, '<|assistant|>')
    .replace(/<\|end\|>/gi, '<|end|>');
}

// 角色映射表：OpenAI 角色 -> Fitten Code 支持的角色
const FITTEN_ROLE_MAPPING = {
  'system': 'system',
  'developer': 'system',
  'user': 'user',
  'assistant': 'assistant',
  'tool': 'tool'
};

// 归一化角色到 Fitten Code 支持的角色
function normalizeRole(role) {
  if (typeof role !== 'string') return 'user';
  const normalized = role.toLowerCase().trim();
  return FITTEN_ROLE_MAPPING[normalized] || 'user';
}

// 把 OpenAI tools 描述转成文本，注入到 system message 中
// 让 Fitten 模型知道有哪些工具可用
function buildFittenInputs(messages, tools) {
  const toolDescriptions = buildToolDescriptions(tools);
  const hasSystemMessage = messages.some((msg) => msg.role === 'system' || msg.role === 'developer');

  // 如果有 tools 但没有 system message，先注入一条空的 system message
  let result = '';
  if (toolDescriptions && !hasSystemMessage) {
    result += `<|system|>\n${toolDescriptions}\n<|end|>\n`;
  }

  result += messages
    .map((message) => {
      // 如果是 system message 且有 tools，把工具描述追加到 system 内容后面
      if (toolDescriptions && (message.role === 'system' || message.role === 'developer')) {
        const safeContent = escapeFittenTags(message.content);
        return `<|system|>\n${safeContent}\n\n${toolDescriptions}\n<|end|>`;
      }
      return buildFittenInputBlock(message);
    })
    .filter(Boolean)
    .join('\n') + '\n<|assistant|>';

  return result;
}

// 把 OpenAI tools 数组转成文本描述
// 注意：不包含 JSON schema，避免模型被带偏去输出 JSON
function buildToolDescriptions(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;

  const lines = tools.map((tool, index) => {
    const func = tool.function || {};
    const name = func.name || `tool_${index}`;
    const description = func.description || '';
    const paramNames = extractParamNames(func.parameters);

    let text = `- ${name}`;
    if (description) text += `: ${description}`;
    if (paramNames) text += `\n  参数: ${paramNames}`;
    return text;
  });

  return `你只能通过 XML <function_calls> 格式调用工具，绝不能输出 JSON 或纯文本描述。

正确的调用格式（请严格遵循）：
<function_calls>
  <工具名 参数1="值1" 参数2="值2" />
</function_calls>

示例：
<function_calls>
  <execute_command command="ls -la" cwd="." />
</function_calls>

可用工具列表：
${lines.join('\n')}`;
}

// 从 JSON schema 中提取参数名列表（不包含 schema 本身，避免模型被带偏）
function extractParamNames(parameters) {
  if (!parameters || typeof parameters !== 'object') return null;
  const properties = parameters.properties;
  if (!properties || typeof properties !== 'object') return null;
  const names = Object.keys(properties);
  if (names.length === 0) return null;
  return names.join(', ');
}

function buildFittenInputBlock(message) {
  const safeContent = escapeFittenTags(message.content);
  const role = normalizeRole(message.role);

  if (role === 'system') return `<|system|>\n${safeContent}\n<|end|>`;
  if (role === 'user') return `<|user|>\n${safeContent}\n<|end|>`;
  if (role === 'assistant') return `<|assistant|>\n${safeContent}\n<|end|>`;

  // tool result：用 <function_results> XML 块包装，以 user 角色回传
  // 让模型明确知道"这是工具执行结果"，而不是它自己的输出
  if (role === 'tool') {
    const toolResultXml = buildToolResultXml(message);
    return `<|user|>\n${toolResultXml}\n<|end|>`;
  }

  return '';
}

// 把 tool result 消息转成 <function_results> XML 格式
function buildToolResultXml(message) {
  const toolCallId = message.tool_call_id || 'unknown';
  const name = message.name || message.tool_name || 'tool';
  const content = message.content || '';

  return `<function_results>
<result tool_call_id="${escapeXmlAttr(toolCallId)}" tool_name="${escapeXmlAttr(name)}">
${escapeFittenTags(content)}
</result>
</function_results>`;
}

// 转义 XML 属性值中的特殊字符
function escapeXmlAttr(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/&/g, '&')
    .replace(/"/g, '"')
    .replace(/</g, '<')
    .replace(/>/g, '>');
}

function parseFittenEventLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return { delta: parsed.delta, usage: parsed.usage };
  } catch {
    return { delta: trimmed };
  }
}

// ============================================
// 启动服务
// ============================================

app.listen(port, () => {
  console.log(`fitten code 2api is running at http://localhost:${port}`);
});
