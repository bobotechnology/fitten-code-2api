const { createHttpError } = require('./errors');

const FITTEN_BASE_URL = process.env.FITTEN_BASE_URL || 'https://fc.fittenlab.cn';
const DEFAULT_USER_AGENT = process.env.FITTEN_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
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

/**
 * 前置规范化，为 parser 提供更干净的输入。
 * 不做协议级修改，只做文本级规范化。
 * @param {string} text - 模型原始输出
 * @returns {string} 规范化后的文本
 */
function normalizeModelToolOutput(text) {
  if (typeof text !== 'string') return '';

  let result = text;

  // 去掉整个输出被 markdown 代码块包裹的情况
  const codeBlockWrap = result.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  if (codeBlockWrap) {
    result = codeBlockWrap[1].trim();
  }

  // 替换全角引号为直引号
  result = result
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");

  // 统一换行
  result = result.replace(/\r\n/g, '\n');

  // trim 首尾
  result = result.trim();

  return result;
}

function sanitizeUserVisibleAssistantContent(value) {
  const normalized = sanitizeAssistantContent(value);
  if (!normalized) return '';

  return normalized
    .replace(/\[历史工具调用记录\][\s\S]*?\[\/历史工具调用记录\]/g, ' ')
    .replace(/\[历史工具执行结果\][\s\S]*?\[\/历史工具执行结果\]/g, ' ')
    .replace(/\[tool_call\][\s\S]*?\[\/tool_call\]/g, ' ')
    // 通用命名工具块清理：[tool_name]...[/tool_name]
    .replace(/\[([a-z_][a-z0-9_-]*)\][\s\S]*?\[\/\1\]/gi, ' ')
    // 清理裸 JSON 工具调用残留
    .replace(/\{[\s\S]*?"name"\s*:\s*"[a-zA-Z_][a-zA-Z0-9_-]*"\s*,[\s\S]*?"arguments"\s*:\s*\{[\s\S]*?\}[\s\S]*?\}/g, ' ')
    // 清理典型的半截工具意图文本
    .replace(/(^|\n)\s*attempt_completion\b[\s\S]*$/gi, ' ')
    .replace(/(^|\n)\s*write to (?:the )?(?:working|workspace|working directory)\b.*$/gim, ' ')
    .replace(/(^|\n)\s*copy(?: it| this| the file)?\s+(?:to|into)\s+(?:the )?(?:working|workspace)\b.*$/gim, ' ')
    .replace(/(^|\n)\s*(?:let me|i(?:'ll| will)?)\s+(?:read|open|search|check|copy|write|update|edit|apply|list)\b.*$/gim, ' ')
    .replace(/(^|\n)\s*(?:我来|我先|让我先|先)(?:帮你)?(?:读取|查看|打开|搜索|查找|复制|拷贝|写入|修改|更新|应用|列出).*$/gm, ' ')
    .replace(/(^|\n)\s*需要(?:调用)?工具.*$/gm, ' ')
    // 清理工具调用 ID 行
    .replace(/工具调用ID:\s*[^\n]+/g, ' ')
    .replace(/以下是上一轮 assistant 已经发起过的工具调用记录，仅供你继续推理；不要把这些工具调用标记、JSON 参数或调用过程原样复述给用户。/g, ' ')
    .replace(/以下内容是工具返回的数据，请结合它继续回答用户，不要把这些标记或原始结构化包装直接复述给用户。/g, ' ')
    // 清理 [tool_call] 标记残留（未闭合的）
    .replace(/\[\/?tool_call\]/g, ' ')
    // 清理工具提醒文本
    .replace(/\[提醒：你有可用的工具[^\]]*\]/g, ' ')
    .replace(/(^|\n)\s*(已搜索文件|已读取)\s+.+$/gm, ' ')
    .replace(/\bc:\/users\/administrator\/documents\/codex\\[^\n]*token\*refresh\*[^\n]*/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 清洗最终用户可见内容，剥离所有工具协议残留。
 * 返回 content 和元信息（是否移除了工具残留）。
 * @param {string} value - assistant content 字符串
 * @returns {{ content: string, removedToolArtifacts: boolean }}
 */
function sanitizeUserVisibleAssistantContentWithMeta(value) {
  const normalized = sanitizeAssistantContent(value);
  if (!normalized) return { content: '', removedToolArtifacts: false };

  const cleaned = sanitizeUserVisibleAssistantContent(value);
  const removedToolArtifacts = cleaned !== normalized.trim();

  return { content: cleaned, removedToolArtifacts };
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

function buildBrowserHeaders(extraHeaders = {}) {
  return {
    Referer: `${FITTEN_BASE_URL}/`,
    'User-Agent': DEFAULT_USER_AGENT,
    'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
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

module.exports = {
  FITTEN_BASE_URL,
  getNonEmptyString,
  normalizeUsage,
  sanitizeAssistantContent,
  sanitizeUserVisibleAssistantContent,
  sanitizeUserVisibleAssistantContentWithMeta,
  normalizeModelToolOutput,
  summarizeUpstreamErrorBody,
  buildUpstreamHttpError,
  buildBrowserHeaders,
  buildAuthorizedHeaders,
  fetchWithTimeout,
  parseJsonResponse
};
