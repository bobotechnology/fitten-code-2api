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
      const name = tc.function?.name || '';
      const args = tc.function?.arguments || '{}';
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
 */
function formatToolResultMessage(item) {
  const content = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
  return `<function_results>\n${content}\n</function_results>`;
}

module.exports = {
  buildToolCall,
  buildToolCallsResponse,
  formatAssistantToolCallsMessage,
  formatToolResultMessage
};
