const crypto = require('crypto');
const {
  parseXmlToolCallsFromText,
  hasFunctionCalls,
  stripXmlToolCalls,
  hasJsonToolCall,
  parseJsonToolCallsFromText,
  parseTextToolCalls
} = require('./parse-xml-tool-calls');
const { normalizeUsage } = require('./helpers');

function buildOpenAiResponse(model, content, events) {
  const usageEvent = events.find((event) => event && typeof event.usage === 'object');

  let toolCalls = hasFunctionCalls(content) ? parseXmlToolCallsFromText(content) : [];

  if (toolCalls.length === 0 && hasJsonToolCall(content)) {
    toolCalls = parseJsonToolCallsFromText(content);
  }

  if (toolCalls.length === 0) {
    toolCalls = parseTextToolCalls(content);
  }

  const cleanContent = stripXmlToolCalls(content);

  const message = { role: 'assistant', content: cleanContent || '' };
  if (toolCalls.length > 0) message.tool_calls = buildOpenAiToolCalls(toolCalls);

  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
    }],
    usage: normalizeUsage(usageEvent?.usage)
  };
}

function buildOpenAiToolCalls(toolCalls) {
  return toolCalls.map((toolCall, index) => ({
    index,
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.function.name,
      arguments: JSON.stringify(toolCall.function.arguments)
    }
  }));
}

function detectToolCalls(content) {
  let toolCalls = hasFunctionCalls(content) ? parseXmlToolCallsFromText(content) : [];

  if (toolCalls.length === 0 && hasJsonToolCall(content)) {
    toolCalls = parseJsonToolCallsFromText(content);
  }

  if (toolCalls.length === 0) {
    toolCalls = parseTextToolCalls(content);
  }

  if (!toolCalls.length) return null;
  return buildOpenAiToolCalls(toolCalls);
}

module.exports = {
  buildOpenAiResponse,
  buildOpenAiToolCalls,
  detectToolCalls
};
