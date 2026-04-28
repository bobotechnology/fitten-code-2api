const crypto = require('crypto');
const { normalizeError, createHttpError } = require('./errors');
const { normalizeUsage, sanitizeAssistantContent } = require('./helpers');

function writeSseEvent(response, payload) {
  response.write(`data: ${payload}\n\n`);
  response.flush?.();
}

function writeOpenAiStreamError(response, error) {
  const normalized = normalizeError(error);
  writeSseEvent(response, JSON.stringify({
    error: {
      message: normalized.message,
      type: normalized.type,
      code: normalized.code,
      param: normalized.param
    }
  }));
  writeSseEvent(response, '[DONE]');
  response.end();
}

function beginOpenAiStream(response, model, options = {}) {
  response.status(200);
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');

  const streamState = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    model,
    includeUsage: options && options.include_usage === true,
    usage: undefined,
    sawContent: false,
    pendingContent: ''
  };

  response.flushHeaders?.();
  writeSseEvent(response, JSON.stringify(buildChunk(streamState.id, streamState.created, model, { role: 'assistant' }, null)));
  return streamState;
}

function writeOpenAiContentChunk(response, streamState, event) {
  if (event && typeof event.usage === 'object') {
    streamState.usage = normalizeUsage(event.usage);
  }

  const delta = normalizeStreamDelta(event);
  if (!delta) return;

  streamState.pendingContent += delta;
  flushPendingContent(response, streamState, { force: shouldFlushStreamContent(streamState.pendingContent) });
}

function normalizeStreamDelta(event) {
  const delta = typeof event?.delta === 'string' ? event.delta : '';
  if (!delta) return '';
  return sanitizeAssistantContent(delta);
}

function shouldFlushStreamContent(content) {
  if (!content) return false;
  if (!content.trim()) return false;
  if (content.length >= 24) return true;
  if (/\S(?:.|\s)*\n{2,}$/.test(content)) return true;
  if (/[。！？!?；;：:，,、]\s*$/.test(content)) return true;
  if (/\s$/.test(content) && /[^\s]$/.test(content.trimEnd())) return true;
  return false;
}

function flushPendingContent(response, streamState, options = {}) {
  const force = options.force === true;
  if (!streamState.pendingContent) return;
  if (!force) return;

  streamState.sawContent = true;
  writeSseEvent(response, JSON.stringify(buildChunk(streamState.id, streamState.created, streamState.model, { content: streamState.pendingContent }, null)));
  streamState.pendingContent = '';
}

function finishOpenAiStream(response, streamState) {
  flushPendingContent(response, streamState, { force: true });
  writeSseEvent(response, JSON.stringify(buildChunk(streamState.id, streamState.created, streamState.model, {}, 'stop')));

  if (streamState.includeUsage && streamState.usage) {
    writeSseEvent(response, JSON.stringify({
      id: streamState.id,
      object: 'chat.completion.chunk',
      created: streamState.created,
      model: streamState.model,
      choices: [],
      usage: streamState.usage
    }));
  }

  writeSseEvent(response, '[DONE]');
  response.end();
}

async function pipeFittenStreamAsOpenAi(response, model, upstreamResponse, options = {}, clientSignal) {
  const streamState = beginOpenAiStream(response, model, options);

  if (!upstreamResponse.body) {
    const text = await upstreamResponse.text();
    const events = parseFittenEvents(text);
    for (const event of events) {
      if (clientSignal?.aborted) return;
      writeOpenAiContentChunk(response, streamState, event);
    }
    if (!clientSignal?.aborted) finishOpenAiStream(response, streamState);
    return;
  }

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
        writeOpenAiContentChunk(response, streamState, event);
      }
    }

    buffer += decoder.decode();
    const trailing = buffer.trim();
    if (trailing && !clientSignal?.aborted) {
      writeOpenAiContentChunk(response, streamState, parseFittenEventLine(trailing));
    }

    if (!clientSignal?.aborted) finishOpenAiStream(response, streamState);
  } catch (error) {
    if (clientSignal?.aborted) return;
    if (!response.headersSent) {
      throw error;
    }

    writeOpenAiStreamError(response, error);
  } finally {
    reader.releaseLock();
  }
}

function parseFittenEvents(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      events.push({ delta: line, raw: line, parse_error: true });
    }
  }

  if (!events.length) {
    throw createHttpError(502, 'fitten returned empty response', { type: 'server_error', code: 'empty_upstream_response' });
  }

  return events;
}

function parseFittenEventLine(line) {
  try {
    return JSON.parse(line);
  } catch (error) {
    return { delta: line, raw: line, parse_error: true };
  }
}

function buildChunk(id, created, model, delta, finishReason) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason
      }
    ]
  };
}

function createClientAbortController(response) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('client disconnected'));
    }
  };

  response.on('close', abort);
  return {
    signal: controller.signal,
    cleanup: () => response.off('close', abort)
  };
}

module.exports = {
  writeSseEvent,
  writeOpenAiStreamError,
  shouldFlushStreamContent,
  beginOpenAiStream,
  writeOpenAiContentChunk,
  finishOpenAiStream,
  pipeFittenStreamAsOpenAi,
  parseFittenEvents,
  parseFittenEventLine,
  createClientAbortController
};

