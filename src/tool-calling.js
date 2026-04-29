const crypto = require('crypto');

/**
 * 构建 OpenAI 格式的 tool_call 对象
 */
function buildToolCall(name, args) {
  return {
    id: `call_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`,
    type: 'function',
    function: {
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args)
    }
  };
}

/**
 * 构建 tool_calls 响应
 */
function buildToolCallsResponse(id, created, model, toolCalls, usage) {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: toolCalls
      },
      finish_reason: 'tool_calls'
    }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

/**
 * 转义 XML 特殊字符
 */
function escapeXML(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 格式化 assistant 的 tool_calls 消息为文本
 * 用于将 tool_calls 转成 Fitten Code 能理解的格式
 */
function formatAssistantToolCallsMessage(message) {
  if (!message.tool_calls || !Array.isArray(message.tool_calls)) {
    return '';
  }

  const lines = [];
  for (const tc of message.tool_calls) {
    if (tc.type === 'function') {
      const name = escapeXML(tc.function?.name || '');
      const args = escapeXML(tc.function?.arguments || '{}');
      lines.push(`<function_calls>`);
      lines.push(`<invoke name="use_tool">`);
      lines.push(`<parameter name="tool_name">${name}</parameter>`);
      lines.push(`<parameter name="arguments">${args}</parameter>`);
      lines.push(`</invoke>`);
      lines.push(`</function_calls>`);
    }
  }

  return lines.join('\n');
}

/**
 * 格式化 tool 结果为文本
 * 使用 CDATA 包装，防止内容被解析为 XML
 */
function formatToolResultMessage(item) {
  const content = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);

  // 如果内容包含 ]]>, 需要转义
  const safeContent = content.replace(/]]>/g, ']]]]><![CDATA[>');

  // 使用 CDATA 包装，更安全
  return `<function_results>\n<![CDATA[\n${safeContent}\n]]>\n</function_results>`;
}

module.exports = {
  buildToolCall,
  buildToolCallsResponse,
  formatAssistantToolCallsMessage,
  formatToolResultMessage
};
