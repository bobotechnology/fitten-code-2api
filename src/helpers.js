const { createHttpError } = require('./errors');

const FITTEN_BASE_URL = process.env.FITTEN_BASE_URL || 'https://fc.fittenlab.cn';
const DEFAULT_USER_AGENT = process.env.FITTEN_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const FITTEN_REQUEST_TIMEOUT_MS = Number(process.env.FITTEN_REQUEST_TIMEOUT_MS || 120000);

function getNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeUsage(usage) {
  if (!usage) return undefined;

  return {
    prompt_tokens: numberOrZero(usage.input_tokens),
    completion_tokens: numberOrZero(usage.output_tokens),
    total_tokens: numberOrZero(usage.input_tokens) + numberOrZero(usage.output_tokens)
  };
}

function sanitizeAssistantContent(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/^\u0000+/g, '')
    .replace(/^\uFEFF+/g, '');
}

function buildBrowserHeaders(extraHeaders = {}) {
  return {
    Referer: `${FITTEN_BASE_URL}/`,
    'User-Agent': DEFAULT_USER_AGENT,
    'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    ...extraHeaders
  };
}

function buildAuthorizedHeaders(accessToken, extraHeaders = {}) {
  return buildBrowserHeaders({
    Authorization: `Bearer ${accessToken}`,
    ...extraHeaders
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FITTEN_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const externalSignal = options.signal;
  const cleanupHandlers = [];

  const onAbort = () => controller.abort(externalSignal?.reason || new Error('request aborted'));
  if (externalSignal) {
    if (externalSignal.aborted) onAbort();
    else {
      externalSignal.addEventListener('abort', onAbort, { once: true });
      cleanupHandlers.push(() => externalSignal.removeEventListener('abort', onAbort));
    }
  }

  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(new Error(`upstream request timed out after ${timeoutMs}ms`)), timeoutMs)
    : null;

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    const reason = controller.signal.aborted ? controller.signal.reason : null;
    const reasonMessage = reason instanceof Error ? reason.message : String(reason || error?.message || 'request aborted');

    if (controller.signal.aborted || error?.name === 'AbortError') {
      if (/timed out/i.test(reasonMessage)) {
        throw createHttpError(504, reasonMessage, { type: 'server_error', code: 'upstream_timeout' });
      }
      throw createHttpError(499, reasonMessage, { type: 'server_error', code: 'client_closed_request' });
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    cleanupHandlers.forEach((handler) => handler());
  }
}

async function parseJsonResponse(response, label) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw createHttpError(502, `${label} returned invalid json: ${text.slice(0, 500)}`, {
      type: 'server_error',
      code: 'invalid_upstream_json'
    });
  }
}

function summarizeUpstreamErrorBody(statusCode, body) {
  const text = String(body || '').trim();
  if (!text) {
    return statusCode >= 500 ? 'upstream service temporarily unavailable' : 'upstream request failed';
  }

  const stripped = text
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();

  if (/504\s+gateway\s+time-?out/i.test(text) || /504\s+gateway\s+time-?out/i.test(stripped)) {
    return 'upstream gateway timeout';
  }
  if (/502\s+bad\s+gateway/i.test(text) || /502\s+bad\s+gateway/i.test(stripped)) {
    return 'upstream bad gateway';
  }
  if (/503\s+service\s+temporarily\s+unavailable/i.test(text) || /503\s+service\s+temporarily\s+unavailable/i.test(stripped)) {
    return 'upstream service temporarily unavailable';
  }
  if (/nginx/i.test(text) && statusCode >= 500) {
    return 'upstream gateway error';
  }

  return (stripped || text).slice(0, 300);
}

function buildUpstreamHttpError(statusCode, body, metadata = {}) {
  const summary = summarizeUpstreamErrorBody(statusCode, body);
  return createHttpError(statusCode, `fitten chat request failed: ${summary}`, metadata);
}

module.exports = {
  FITTEN_BASE_URL,
  getNonEmptyString,
  normalizeUsage,
  sanitizeAssistantContent,
  buildBrowserHeaders,
  buildAuthorizedHeaders,
  fetchWithTimeout,
  parseJsonResponse,
  buildUpstreamHttpError
};
