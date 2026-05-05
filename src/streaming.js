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
    pendingContent: '',
    accumulatedContent: '', // 完整累积内容，用于 finish 时检测 tool_calls
    onComplete: typeof options.onComplete === 'function' ? options.onComplete : null,
    toolCallDetector: typeof options.toolCallDetector === 'function' ? options.toolCallDetector : null
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
  streamState.accumulatedContent += delta;
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

async function finishOpenAiStream(response, streamState) {
  flushPendingContent(response, streamState, { force: true });

  // 检测 XML function_calls 并转成 OpenAI tool_calls chunk
  // 用 accumulatedContent（完整累积内容），因为 pendingContent 已被 flush 清空
  const toolCalls = streamState.toolCallDetector
    ? streamState.toolCallDetector(streamState.accumulatedContent)
    : null;

  if (toolCalls && toolCalls.length > 0) {
    // 增量发送 tool_calls（OpenAI 标准格式）
    writeToolCallsIncremental(response, streamState, toolCalls);
  } else {
    writeSseEvent(response, JSON.stringify(buildChunk(streamState.id, streamState.created, streamState.model, {}, 'stop')));
  }

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

  if (streamState.onComplete) {
    await streamState.onComplete(streamState.accumulatedContent);
  }
}

// 增量发送 tool_calls（OpenAI 标准流式格式）
// 每个 tool_call 分 3 步发送：
//   1. {tool_calls: [{index, id, type}]}
//   2. {tool_calls: [{index, function: {name}}]}
//   3. {tool_calls: [{index, function: {arguments: "..."}}]}（可能分多个 fragment）
function writeToolCallsIncremental(response, streamState, toolCalls) {
  for (let index = 0; index < toolCalls.length; index += 1) {
    const tc = toolCalls[index];

    // 第 1 步：发送 id + type
    writeSseEvent(response, JSON.stringify(buildChunk(streamState.id, streamState.created, streamState.model, {
      tool_calls: [{
        index,
        id: tc.id,
        type: 'function'
      }]
    }, null)));

    // 第 2 步：发送 function.name
    writeSseEvent(response, JSON.stringify(buildChunk(streamState.id, streamState.created, streamState.model, {
      tool_calls: [{
        index,
        function: { name: tc.function.name }
      }]
    }, null)));

    // 第 3 步：发送 function.arguments（分片发送，每片约 100 字符）
    const argsText = tc.function.arguments;
    const fragmentSize = 100;
    for (let offset = 0; offset < argsText.length; offset += fragmentSize) {
      const fragment = argsText.slice(offset, offset + fragmentSize);
      writeSseEvent(response, JSON.stringify(buildChunk(streamState.id, streamState.created, streamState.model, {
        tool_calls: [{
          index,
          function: { arguments: fragment }
        }]
      }, null)));
    }
  }

  // 最后：发送空 delta + finish_reason = "tool_calls"
  writeSseEvent(response, JSON.stringify(buildChunk(streamState.id, streamState.created, streamState.model, {}, 'tool_calls')));
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
    if (!clientSignal?.aborted) {
      // 非 body 路径：手动设置 accumulatedContent
      if (!streamState.accumulatedContent) {
        streamState.accumulatedContent = events
          .map((e) => (typeof e.delta === 'string' ? e.delta : ''))
          .join('');
      }
      await finishOpenAiStream(response, streamState);
    }
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

    if (!clientSignal?.aborted) await finishOpenAiStream(response, streamState);
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

