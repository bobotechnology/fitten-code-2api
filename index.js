require('dotenv').config({ quiet: true });

const express = require('express');
const crypto = require('crypto');
const { normalizeError } = require('./src/errors');
const { FITTEN_BASE_URL, buildAuthorizedHeaders, fetchWithTimeout, normalizeUsage, buildUpstreamHttpError } = require('./src/helpers');
const { buildOpenAiRequest, getFittenCredentials, DEFAULT_MODEL } = require('./src/openai-request');
const { buildToolCallsResponse, buildToolCall } = require('./src/tool-calling');
const { buildAgentPayload, parseAgentResponse } = require('./src/agent-mode');
const { getFittenSession, clearCachedSession, ensureValidAccessToken, refreshSessionTokens, sessionCache } = require('./src/session');
const { parseFittenEvents, pipeFittenStreamAsOpenAi, createClientAbortController, writeSseEvent, writeOpenAiStreamError } = require('./src/streaming');

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

    // 构建请求 payload
    let fittenPayload;
    if (openaiRequest.tools && openaiRequest.tools.length) {
      // 有 tools 时使用 XML function calling 格式
      fittenPayload = buildAgentPayload(
        openaiRequest.messages,
        openaiRequest.tools,
        session,
        { sessionId: `session-${Date.now()}` }
      );
      fittenPayload.mode = 'agent';
    } else {
      // 无 tools 时普通请求
      fittenPayload = {
        inputs: buildFittenInputs(openaiRequest.messages),
        ft_token: session.userId
      };
      fittenPayload.mode = 'chat';
    }

    if (openaiRequest.stream) {
      return await sendChatStreamWithRetry(response, openaiRequest, session, fittenPayload, credentials);
    }

    const fittenResult = await sendChatWithRetry(session, fittenPayload, credentials);

    // 有 tools 时解析 XML function calling
    if (openaiRequest.tools && openaiRequest.tools.length) {
      const agentResult = parseAgentResponse(fittenResult.events, openaiRequest.tools);

      if (agentResult.toolCalls && agentResult.toolCalls.length > 0) {
        return response.json(buildToolCallsResponse(
          `chatcmpl-${crypto.randomUUID()}`,
          Math.floor(Date.now() / 1000),
          openaiRequest.model,
          agentResult.toolCalls,
          normalizeUsage(fittenResult.events.find((e) => e && typeof e.usage === 'object')?.usage)
        ));
      }

      // 返回普通文本响应
      return response.json(buildOpenAiResponse(openaiRequest.model, agentResult.content, fittenResult.events));
    }

    // 普通文本响应
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

    // 有 tools 时使用 XML function calling 流式处理
    if (payload.mode === 'agent' && openaiRequest.tools?.length) {
      return await pipeAgentStream(response, openaiRequest, upstream, clientAbort.signal);
    }

    return await pipeFittenStreamAsOpenAi(response, openaiRequest.model, upstream, openaiRequest.stream_options, clientAbort.signal);
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
  const requestBody = {
    inputs: payload.inputs,
    ft_token: session.userId
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

function buildOpenAiResponse(model, content, events) {
  const usageEvent = events.find((event) => event && typeof event.usage === 'object');

  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop'
    }],
    usage: normalizeUsage(usageEvent?.usage)
  };
}

// ============================================
// 工具函数
// ============================================

function buildFittenInputs(messages) {
  return messages
    .map((m) => {
      if (m.role === 'system') return `<|system|>\n${m.content}\n<|end|>`;
      if (m.role === 'user') return `<|user|>\n${m.content}\n<|end|>`;
      if (m.role === 'assistant') return `<|assistant|>\n${m.content}\n<|end|>`;
      return '';
    })
    .join('\n') + '\n<|assistant|>';
}

// ============================================
// Agent 流式处理
// ============================================

async function pipeAgentStream(response, openaiRequest, upstreamResponse, clientSignal) {
  const events = [];
  let fullContent = '';

  if (!upstreamResponse.body) {
    const text = await upstreamResponse.text();
    const parsed = parseFittenEvents(text);
    for (const event of parsed) {
      if (clientSignal?.aborted) return;
      if (typeof event.delta === 'string') fullContent += event.delta;
      events.push(event);
    }
  } else {
    const decoder = new TextDecoder();
    const reader = upstreamResponse.body.getReader();
    let buffer = '';

    try {
      while (true) {
        if (clientSignal?.aborted) return;
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\r?\n/);
        buffer = parts.pop() || '';

        for (const line of parts) {
          if (clientSignal?.aborted) return;
          const trimmed = line.trim();
          if (!trimmed) continue;
          const event = parseFittenEventLine(trimmed);
          if (typeof event.delta === 'string') fullContent += event.delta;
          events.push(event);
        }
      }

      if (buffer.trim()) {
        const event = parseFittenEventLine(buffer.trim());
        if (typeof event.delta === 'string') fullContent += event.delta;
        events.push(event);
      }
    } finally {
      reader.releaseLock();
    }
  }

  const agentResult = parseAgentResponse(events, openaiRequest.tools);
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const includeUsage = openaiRequest.stream_options?.include_usage === true;
  const usageEvent = events.find((e) => e && typeof e.usage === 'object');

  response.status(200);
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders?.();

  if (agentResult.toolCalls?.length) {
    // 发送 tool_calls 响应
    writeSseEvent(response, JSON.stringify({
      id, object: 'chat.completion.chunk', created, model: openaiRequest.model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
    }));

    for (let i = 0; i < agentResult.toolCalls.length; i++) {
      const tc = agentResult.toolCalls[i];
      writeSseEvent(response, JSON.stringify({
        id, object: 'chat.completion.chunk', created, model: openaiRequest.model,
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }] },
          finish_reason: null
        }]
      }));
    }

    writeSseEvent(response, JSON.stringify({
      id, object: 'chat.completion.chunk', created, model: openaiRequest.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
    }));
  } else {
    // 发送普通文本响应
    writeSseEvent(response, JSON.stringify({
      id, object: 'chat.completion.chunk', created, model: openaiRequest.model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
    }));

    const content = agentResult.content || fullContent;
    const chunkSize = 20;
    for (let i = 0; i < content.length; i += chunkSize) {
      if (clientSignal?.aborted) return;
      const chunk = content.slice(i, i + chunkSize);
      writeSseEvent(response, JSON.stringify({
        id, object: 'chat.completion.chunk', created, model: openaiRequest.model,
        choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }]
      }));
    }

    writeSseEvent(response, JSON.stringify({
      id, object: 'chat.completion.chunk', created, model: openaiRequest.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    }));
  }

  if (includeUsage && usageEvent) {
    writeSseEvent(response, JSON.stringify({
      id, object: 'chat.completion.chunk', created, model: openaiRequest.model,
      choices: [], usage: normalizeUsage(usageEvent.usage)
    }));
  }

  writeSseEvent(response, '[DONE]');
  response.end();
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
