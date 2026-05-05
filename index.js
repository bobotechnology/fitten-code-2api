require('dotenv').config({ quiet: true });

const express = require('express');
const { normalizeError } = require('./src/errors');
const { buildAuthorizedHeaders, fetchWithTimeout, buildUpstreamHttpError } = require('./src/helpers');
const { buildOpenAiRequest, getFittenCredentials, DEFAULT_MODEL } = require('./src/openai-request');
const { getFittenSession, clearCachedSession, ensureValidAccessToken, refreshSessionTokens, sessionCache } = require('./src/session');
const { parseFittenEvents, pipeFittenStreamAsOpenAi, createClientAbortController, writeOpenAiStreamError } = require('./src/streaming');
const { buildFittenChatPayload } = require('./src/fitten-payloads');
const { buildOpenAiResponse, detectToolCalls } = require('./src/tool-calls');
const { buildFittenInputs } = require('./src/inputs');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));

// 根路由
app.get('/', (request, response) => {
  response.json({
    message: 'fitten code 2api is running',
    endpoints: ['/v1/models', '/v1/chat/completions']
  });
});

// 模型列表
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

// 聊天补全
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

    if (!session || !session.userId || !session.accessToken) {
      return response.status(500).json({
        error: {
          message: 'Failed to get valid session, please check credentials',
          type: 'server_error',
          code: 'session_error'
        }
      });
    }

    const fittenPayload = buildFittenChatPayload(session, {
      inputs: buildFittenInputs(openaiRequest.messages, openaiRequest.tools)
    });

    if (openaiRequest.stream) {
      return await sendChatStreamWithRetry(response, openaiRequest, session, fittenPayload, credentials);
    }

    const fittenResult = await sendChatWithRetry(session, fittenPayload, credentials);

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

// 非流式请求
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

// 流式请求
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
        toolCallDetector: detectToolCalls
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

// 上游请求
async function openChatRequest(session, payload, options = {}) {
  if (!session || !session.userId || !session.accessToken) {
    throw new Error('Invalid session: missing userId or accessToken');
  }

  const requestBody = {
    inputs: payload.inputs,
    ft_token: payload.ft_token || session.userId,
    meta_datas: payload.meta_datas
  };

  return fetchWithTimeout(`${process.env.FITTEN_BASE_URL || 'https://fc.fittenlab.cn'}/codeapi/chat_auth?apikey=${encodeURIComponent(session.userId)}`, {
    method: 'POST',
    headers: buildAuthorizedHeaders(session.accessToken, {
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson, application/json, text/plain, */*'
    }),
    body: JSON.stringify(requestBody),
    signal: options.signal
  });
}

// 启动服务
app.listen(port, () => {
  console.log(`fitten code 2api is running at http://localhost:${port}`);
});
