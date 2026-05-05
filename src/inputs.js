const { getNonEmptyString } = require('./helpers');

const FITTEN_ROLE_MAPPING = {
  system: 'system',
  developer: 'system',
  user: 'user',
  assistant: 'assistant',
  tool: 'tool'
};

function escapeFittenTags(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<\|system\|>/gi, '<|system|>')
    .replace(/<\|user\|>/gi, '<|user|>')
    .replace(/<\|assistant\|>/gi, '<|assistant|>')
    .replace(/<\|end\|>/gi, '<|end|>');
}

function escapeXmlAttr(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/&/g, '&')
    .replace(/"/g, '"')
    .replace(/</g, '<')
    .replace(/>/g, '>');
}

function normalizeRole(role) {
  if (typeof role !== 'string') return 'user';
  const normalized = role.toLowerCase().trim();
  return FITTEN_ROLE_MAPPING[normalized] || 'user';
}

function extractParamNames(parameters) {
  if (!parameters || typeof parameters !== 'object') return null;
  const properties = parameters.properties;
  if (!properties || typeof properties !== 'object') return null;
  const names = Object.keys(properties);
  if (names.length === 0) return null;
  return names.join(', ');
}

function buildToolDescriptions(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;

  const lines = tools.map((tool, index) => {
    const func = tool.function || {};
    const name = func.name || `tool_${index}`;
    const description = func.description || '';
    const paramNames = extractParamNames(func.parameters);

    let text = `- ${name}`;
    if (description) text += `: ${description}`;
    if (paramNames) text += `\n  参数: ${paramNames}`;
    return text;
  });

  return `你只能通过 XML <function_calls> 格式调用工具，绝不能输出 JSON 或纯文本描述。

正确的调用格式（请严格遵循）：
<function_calls>
  <工具名 参数1="值1" 参数2="值2" />
</function_calls>

示例：
<function_calls>
  <execute_command command="ls -la" cwd="." />
</function_calls>

可用工具列表：
${lines.join('\n')}`;
}

function buildToolResultXml(message) {
  const toolCallId = message.tool_call_id || 'unknown';
  const name = message.name || message.tool_name || 'tool';
  const content = message.content || '';

  return `<function_results>
<result tool_call_id="${escapeXmlAttr(toolCallId)}" tool_name="${escapeXmlAttr(name)}">
${escapeFittenTags(content)}
</result>
</function_results>`;
}

function buildFittenInputBlock(message) {
  const safeContent = escapeFittenTags(message.content);
  const role = normalizeRole(message.role);

  if (role === 'system') return `<|system|>\n${safeContent}\n<|end|>`;
  if (role === 'user') return `<|user|>\n${safeContent}\n<|end|>`;
  if (role === 'assistant') return `<|assistant|>\n${safeContent}\n<|end|>`;

  if (role === 'tool') {
    const toolResultXml = buildToolResultXml(message);
    return `<|user|>\n${toolResultXml}\n<|end|>`;
  }

  return '';
}

function buildFittenInputs(messages, tools) {
  const toolDescriptions = buildToolDescriptions(tools);
  const hasSystemMessage = messages.some((msg) => msg.role === 'system' || msg.role === 'developer');

  let result = '';
  if (toolDescriptions && !hasSystemMessage) {
    result += `<|system|>\n${toolDescriptions}\n<|end|>\n`;
  }

  result += messages
    .map((message) => {
      if (toolDescriptions && (message.role === 'system' || message.role === 'developer')) {
        const safeContent = escapeFittenTags(message.content);
        return `<|system|>\n${safeContent}\n\n${toolDescriptions}\n<|end|>`;
      }
      return buildFittenInputBlock(message);
    })
    .filter(Boolean)
    .join('\n') + '\n<|assistant|>';

  return result;
}

module.exports = {
  buildFittenInputs,
  escapeFittenTags,
  escapeXmlAttr,
  normalizeRole
};
