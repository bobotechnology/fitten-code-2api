const { createHttpError } = require('./errors');
const {
  buildBrowserHeaders,
  fetchWithTimeout,
  getNonEmptyString
} = require('./helpers');
const {
  hasFunctionCalls,
  parseXmlToolCallsFromText,
  buildXmlToolCallText,
  stripXmlToolCalls
} = require('./parse-xml-tool-calls');

const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 5 * 1024 * 1024);

async function cleanMessages(items) {
  const result = [];
  for (const item of items) {
    if (!(await isValidMessage(item))) continue;
    result.push(await cleanMessage(item));
  }
  return result;
}

function ensureDefaultSystemMessage(messages) {
  const hasSystem = messages.some((item) => item.role === 'system');
  if (hasSystem) return messages;
  return [{ role: 'system', content: '请完全使用中文回答。' }, ...messages];
}

async function isValidMessage(item) {
  if (!item || typeof item !== 'object') return false;
  if (typeof item.role !== 'string') return false;

  const content = await normalizeMessageContent(item.content, item);
  return typeof content === 'string' && content.length > 0;
}

async function cleanMessage(item) {
  return {
    role: item.role.trim(),
    content: await normalizeMessageContent(item.content, item)
  };
}

async function normalizeMessageContent(content, item = null) {
  let text = '';

  if (typeof content === 'string') {
    text = content.trim();
  } else if (Array.isArray(content)) {
    const parts = [];
    let imageCount = 0;
    for (const part of content) {
      const normalizedPart = await normalizeContentPart(part);
      if (!normalizedPart) continue;
      if (normalizedPart.kind === 'image') imageCount += 1;
      if (imageCount > 1) {
        throw createHttpError(400, 'only one image is currently supported per message', {
          type: 'invalid_request_error',
          code: 'multiple_images_not_supported',
          param: 'messages.content'
        });
      }
      parts.push(normalizedPart);
    }
    text = buildStructuredMessageContent(parts);
  }

  return buildMessageContentWithToolState(text, item);
}

async function normalizeContentPart(part) {
  if (typeof part === 'string') return { kind: 'text', value: part };
  if (!part || typeof part !== 'object') return null;

  if (part.type === 'text' || part.type === 'input_text') {
    const value = getNonEmptyString(part.text);
    return value ? { kind: 'text', value } : null;
  }

  if (part.type === 'output_text') {
    if (typeof part.text === 'string') return part.text ? { kind: 'text', value: part.text } : null;
    if (part.text && typeof part.text.value === 'string') return part.text.value ? { kind: 'text', value: part.text.value } : null;
  }

  if (part.type === 'input_image' || part.type === 'image_url') {
    return normalizeImagePart(part);
  }

  return null;
}

async function normalizeImagePart(part) {
  const imageUrl = extractImageUrl(part);
  if (!imageUrl) return null;

  const normalizedImageUrl = isDataImageUrl(imageUrl)
    ? ensureDataImageWithinLimit(imageUrl)
    : await convertRemoteImageToDataUrl(imageUrl);

  return {
    kind: 'image',
    value: `![Base64 Image](${normalizedImageUrl})`
  };
}

function ensureDataImageWithinLimit(dataUrl) {
  const bytes = getDataImageBytes(dataUrl);
  if (bytes > MAX_IMAGE_BYTES) {
    throw createHttpError(400, `image is too large: ${bytes} bytes exceeds limit ${MAX_IMAGE_BYTES}`, {
      type: 'invalid_request_error',
      code: 'image_too_large',
      param: 'messages.content.image_url'
    });
  }
  return dataUrl;
}

function getDataImageBytes(dataUrl) {
  const match = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\r\n]+)$/i.exec(dataUrl);
  if (!match) {
    throw createHttpError(400, 'invalid data:image base64 payload', {
      type: 'invalid_request_error',
      code: 'invalid_image_data_url',
      param: 'messages.content.image_url'
    });
  }

  try {
    return Buffer.from(match[1].replace(/\s+/g, ''), 'base64').length;
  } catch (error) {
    throw createHttpError(400, 'failed to decode data:image base64 payload', {
      type: 'invalid_request_error',
      code: 'invalid_image_data_url',
      param: 'messages.content.image_url'
    });
  }
}

function extractImageUrl(part) {
  if (typeof part.image_url === 'string') return part.image_url.trim();
  if (part.image_url && typeof part.image_url.url === 'string') return part.image_url.url.trim();
  if (typeof part.url === 'string') return part.url.trim();
  return '';
}

function isDataImageUrl(value) {
  return typeof value === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);
}

function isRemoteHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

async function convertRemoteImageToDataUrl(url) {
  if (!isRemoteHttpUrl(url)) {
    throw createHttpError(400, 'only data:image/... or http/https image URLs are currently supported for image parts', {
      type: 'invalid_request_error',
      code: 'unsupported_image_url',
      param: 'messages.content.image_url'
    });
  }

  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: buildBrowserHeaders({ Accept: 'image/*,*/*;q=0.8' })
  });

  if (!response.ok) {
    throw createHttpError(response.status, `failed to fetch remote image: ${url}`, {
      type: response.status >= 500 ? 'server_error' : 'invalid_request_error',
      code: 'remote_image_fetch_failed',
      param: 'messages.content.image_url'
    });
  }

  const contentType = getNonEmptyString(response.headers.get('content-type')).toLowerCase();
  if (!contentType.startsWith('image/')) {
    throw createHttpError(400, `remote image URL did not return an image content-type: ${contentType || 'unknown'}`, {
      type: 'invalid_request_error',
      code: 'remote_image_not_image',
      param: 'messages.content.image_url'
    });
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) {
    throw createHttpError(400, 'remote image response was empty', {
      type: 'invalid_request_error',
      code: 'remote_image_empty',
      param: 'messages.content.image_url'
    });
  }

  if (bytes.length > MAX_IMAGE_BYTES) {
    throw createHttpError(400, `remote image is too large: ${bytes.length} bytes exceeds limit ${MAX_IMAGE_BYTES}`, {
      type: 'invalid_request_error',
      code: 'image_too_large',
      param: 'messages.content.image_url'
    });
  }

  const mimeType = contentType.split(';')[0].trim();
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

function buildStructuredMessageContent(parts) {
  if (!parts.length) return '';

  const imageParts = parts.filter((part) => part && part.kind === 'image');
  const textParts = parts.filter((part) => part && part.kind === 'text' && getNonEmptyString(part.value));

  if (!imageParts.length) {
    return joinContentParts(textParts.map((part) => part.value));
  }

  const firstImage = imageParts[0];
  const sections = [];

  if (firstImage) {
    sections.push(firstImage.value);
  }

  if (textParts.length) {
    sections.push(joinContentParts(textParts.map((part) => part.value)));
  }

  return sections.join('\n').trim();
}

function joinContentParts(parts) {
  if (!parts.length) return '';

  let result = '';
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) continue;

    if (!result) {
      result = part;
      continue;
    }

    if (shouldSeparateContentParts(result, part, parts[index - 1])) {
      result += `\n${part}`;
    } else {
      result += part;
    }
  }

  return result.trim();
}

function shouldSeparateContentParts(previousWhole, nextPart, previousPart) {
  if (!previousWhole || !nextPart) return false;
  if (previousWhole.endsWith('\n') || nextPart.startsWith('\n')) return false;
  if (isMarkdownImage(previousPart) || isMarkdownImage(nextPart)) return true;
  return false;
}

function isMarkdownImage(value) {
  return typeof value === 'string' && /^!\[[^\]]*\]\((data:image\/[a-z0-9.+-]+;base64,[^)]+|https?:\/\/[^)]+)\)$/i.test(value);
}

function buildMessageContentWithToolState(text, item) {
  const role = typeof item?.role === 'string' ? item.role.trim() : '';

  if (role === 'assistant') {
    // 先处理 OpenAI 风格 tool_calls
    const openAiToolText = buildToolCallTextFromMessage(item);

    // 再检测 XML function_calls（上游模型可能返回 XML 格式）
    const xmlToolText = hasFunctionCalls(text) ? buildXmlToolCallText(text) : '';

    // 如果检测到 XML，从文本中剥离 XML 标签
    const cleanText = hasFunctionCalls(text) ? stripXmlToolCalls(text) : text;

    return mergeTextBlocks(mergeTextBlocks(cleanText, openAiToolText), xmlToolText);
  }

  if (role === 'tool') {
    return buildToolResultText(item, text);
  }

  return text || buildToolCallTextFromMessage(item);
}

function buildToolCallTextFromMessage(item) {
  const toolCalls = getToolCallsFromMessage(item);
  if (!toolCalls.length) return '';

  const blocks = [];
  for (const toolCall of toolCalls) {
    blocks.push(buildSingleToolCallText(toolCall));
  }

  return blocks.join('\n\n').trim();
}

function buildSingleToolCallText(toolCall) {
  const lines = ['[tool_calls]'];
  lines.push(`- id: ${toolCall.id}`);
  lines.push(`- name: ${toolCall.name}`);
  lines.push(`- arguments: ${toolCall.arguments}`);
  return lines.join('\n');
}

function buildToolResultText(item, text) {
  const lines = ['[tool_result]'];
  lines.push(`- tool_call_id: ${getNonEmptyString(item?.tool_call_id) || 'unknown'}`);
  lines.push(`- name: ${getNonEmptyString(item?.name) || getNonEmptyString(item?.tool_name) || 'tool_result'}`);
  if (text) lines.push(`- content: ${text}`);
  return lines.join('\n').trim();
}

function mergeTextBlocks(firstText, secondText) {
  if (firstText && secondText) return `${firstText}\n\n${secondText}`.trim();
  return firstText || secondText || '';
}

function getToolCallsFromMessage(item) {
  if (!item || typeof item !== 'object' || !Array.isArray(item.tool_calls)) return [];

  const result = [];
  for (const toolCall of item.tool_calls) {
    const normalized = normalizeToolCall(toolCall);
    if (normalized) result.push(normalized);
  }

  return result;
}

function normalizeToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return null;

  const toolFunction = toolCall.function && typeof toolCall.function === 'object'
    ? toolCall.function
    : {};

  const id = getNonEmptyString(toolCall.id) || `tool_call_${Date.now()}`;
  const name = getNonEmptyString(toolFunction.name) || getNonEmptyString(toolCall.name) || 'tool_call';
  const argumentsText = normalizeToolCallArguments(toolFunction.arguments ?? toolCall.arguments);

  return { id, name, arguments: argumentsText };
}

function normalizeToolCallArguments(value) {
  if (typeof value === 'string') return value.trim() || '{}';
  if (value && typeof value === 'object') return safeJsonStringify(value);
  return '{}';
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

module.exports = {
  cleanMessages,
  ensureDefaultSystemMessage
};
