const { createHttpError } = require('./errors');
const {
  buildBrowserHeaders,
  fetchWithTimeout,
  getNonEmptyString
} = require('./helpers');
const {
  formatToolResultMessage,
  formatAssistantToolCallsMessage
} = require('./tool-calling');

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

  // assistant 消息带 tool_calls 时，content 可以为 null
  if (item.role === 'assistant' && Array.isArray(item.tool_calls) && item.tool_calls.length) {
    return true;
  }

  const content = await normalizeMessageContent(item.content);
  return typeof content === 'string' && content.length > 0;
}

async function cleanMessage(item) {
  const role = item.role.trim();

  // tool 角色消息：把工具执行结果转成文本
  if (role === 'tool') {
    return {
      role: 'user',
      content: formatToolResultMessage(item)
    };
  }

  // assistant 消息带 tool_calls：把工具调用转成文本
  if (role === 'assistant' && Array.isArray(item.tool_calls) && item.tool_calls.length) {
    const toolCallsText = formatAssistantToolCallsMessage(item);
    const contentText = await normalizeMessageContent(item.content);
    return {
      role: 'assistant',
      content: [toolCallsText, contentText].filter(Boolean).join('\n')
    };
  }

  return {
    role,
    content: await normalizeMessageContent(item.content)
  };
}

async function normalizeMessageContent(content) {
  if (typeof content === 'string') {
    const normalized = content.trim();
    return normalized || '';
  }

  if (!Array.isArray(content)) return '';

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

  return buildStructuredMessageContent(parts);
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

module.exports = {
  cleanMessages,
  ensureDefaultSystemMessage
};
