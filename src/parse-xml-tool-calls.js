/**
 * 解析上游返回的 XML function_calls / function_results。
 *
 * 逆向证据（tmp-fitten-analysis/reverse-engineering-report.md:166-198）确认：
 *   原插件模型侧可能通过 XML 风格内容表达 tool intent，格式为：
 *
 *   <function_calls>
 *     <invoke tool_name="run_terminal">
 *       <arguments>{"command":"npm test"}</arguments>
 *     </invoke>
 *   </function_calls>
 *
 * 这个文件只做两件事：
 *   1. 从 assistant 文本中检测并解析 XML tool calls
 *   2. 把解析结果转成和现有 buildOperationItem() 兼容的结构
 *
 * 它不负责执行工具，只负责"看懂模型想调什么"。
 */

// 检测文本是否包含 function_calls / tool_calls 块
function hasFunctionCalls(text) {
  if (typeof text !== 'string') return false;
  return /<function_calls>[\s\S]*?<\/function_calls>/i.test(text)
    || /\[function_calls\][\s\S]*?\[\/function_calls\]/i.test(text)
    || /\[tool_calls\][\s\S]*?\[\/tool_calls\]/i.test(text)
    || /^\[tool_calls\]\s*\n[\s\S]*?- name:/im.test(text);
}

function hasFunctionCallOpenTag(text) {
  if (typeof text !== 'string') return false;
  return /<function_calls\s*>/i.test(text)
    || /\[function_calls\]/i.test(text)
    || /\[tool_calls\]\s*$/m.test(text);
}

// 从文本中提取所有 function_calls / tool_calls 块
function extractFunctionCallsBlocks(text) {
  if (typeof text !== 'string') return [];

  const patterns = [
    /<function_calls>[\s\S]*?<\/function_calls>/gi,
    /\[function_calls\][\s\S]*?\[\/function_calls\]/gi,
    /\[tool_calls\][\s\S]*?\[\/tool_calls\]/gi
  ];

  const blocks = [];
  for (const regex of patterns) {
    let match;
    while ((match = regex.exec(text)) !== null) {
      blocks.push(match[0]);
    }
  }

  return blocks;
}

// 解析单个 <function_calls> 块，返回 tool call 对象数组
function parseFunctionCallsBlock(xmlBlock) {
  if (typeof xmlBlock !== 'string') return [];

  const toolCalls = [];
  parseInvokeToolCalls(xmlBlock, toolCalls);
  parseFunctionCallWrapperToolCalls(xmlBlock, toolCalls);
  parseNestedTagToolCalls(xmlBlock, toolCalls);
  parseSelfClosingToolCalls(xmlBlock, toolCalls);
  return dedupeToolCalls(toolCalls);
}

function parseInvokeToolCalls(xmlBlock, toolCalls) {
  const invokeRegex = /<invoke\s+tool_name\s*=\s*"([^"]*)"\s*>([\s\S]*?)<\/invoke>/gi;
  let invokeMatch;

  while ((invokeMatch = invokeRegex.exec(xmlBlock)) !== null) {
    const toolName = invokeMatch[1].trim();
    const innerXml = invokeMatch[2];
    const argsMatch = innerXml.match(/<arguments>([\s\S]*?)<\/arguments>/i);
    const argumentsRaw = argsMatch ? argsMatch[1].trim() : '{}';
    const argumentsParsed = parseToolArgumentsFromJson(argumentsRaw);

    toolCalls.push(buildToolCall(toolCalls.length, toolName, argumentsParsed));
  }
}

function parseFunctionCallWrapperToolCalls(xmlBlock, toolCalls) {
  const wrapperRegex = /<function_call\s*>([\s\S]*?)<\/function_call>/gi;
  let wrapperMatch;

  while ((wrapperMatch = wrapperRegex.exec(xmlBlock)) !== null) {
    const innerXml = wrapperMatch[1];
    const nameMatch = innerXml.match(/<name>([\s\S]*?)<\/name>/i);
    const argsMatch = innerXml.match(/<arguments>([\s\S]*?)<\/arguments>/i);
    const toolName = nameMatch ? nameMatch[1].trim() : '';
    const argumentsRaw = argsMatch ? argsMatch[1].trim() : '{}';
    if (!toolName) continue;

    const argumentsParsed = parseArgumentsBlock(argumentsRaw);
    toolCalls.push(buildToolCall(toolCalls.length, toolName, argumentsParsed));
  }
}

function parseNestedTagToolCalls(xmlBlock, toolCalls) {
  const innerContent = stripToolCallWrapper(xmlBlock);

  const nestedRegex = /<([a-z_][a-z0-9_-]*)\b([^<>]*)>([\s\S]*?)<\/\1>/gi;
  let nestedMatch;

  while ((nestedMatch = nestedRegex.exec(innerContent)) !== null) {
    const tagName = nestedMatch[1].trim();
    const attrsText = nestedMatch[2] || '';
    const innerXml = nestedMatch[3] || '';

    if (shouldSkipContainerTag(tagName)) continue;
    if (tagName.toLowerCase() === 'invoke') continue;
    if (tagName.toLowerCase() === 'function_call') continue;
    if (!/<[a-z_][a-z0-9_-]*>/i.test(innerXml)) continue;

    const argumentsParsed = {
      ...parseXmlAttributes(attrsText),
      ...parseSimpleChildTags(innerXml)
    };

    toolCalls.push(buildToolCall(toolCalls.length, tagName, argumentsParsed));
  }
}

function parseSelfClosingToolCalls(xmlBlock, toolCalls) {
  const selfClosingRegex = /<([a-z_][a-z0-9_-]*)\b([^<>]*?)\/>/gi;
  let tagMatch;

  while ((tagMatch = selfClosingRegex.exec(xmlBlock)) !== null) {
    const tagName = tagMatch[1].trim();
    const attrsText = tagMatch[2] || '';

    if (shouldSkipContainerTag(tagName)) continue;

    const argumentsParsed = parseXmlAttributes(attrsText);
    toolCalls.push(buildToolCall(toolCalls.length, tagName, argumentsParsed));
  }
}

function parseToolArgumentsFromJson(argumentsRaw) {
  try {
    return JSON.parse(argumentsRaw);
  } catch {
    return { raw: argumentsRaw };
  }
}

function parseArgumentsBlock(argumentsRaw) {
  const trimmed = String(argumentsRaw || '').trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseToolArgumentsFromJson(trimmed);
  if (/<[a-z_][a-z0-9_-]*>/i.test(trimmed)) return parseSimpleChildTags(trimmed);
  return { raw: trimmed };
}

function parseSimpleChildTags(xmlText) {
  const result = {};
  const childRegex = /<([a-zA-Z_][a-zA-Z0-9_-]*)>([\s\S]*?)<\/\1>/g;
  let childMatch;

  while ((childMatch = childRegex.exec(xmlText)) !== null) {
    const key = childMatch[1];
    const rawValue = decodeXmlEntities(childMatch[2].trim());
    result[key] = normalizeXmlAttributeValue(rawValue);
  }

  return result;
}

function parseXmlAttributes(attrsText) {
  const result = {};
  const attrRegex = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*(?:"([\s\S]*?)"|'([\s\S]*?)'|([^\s"'>/]+))/g;
  let attrMatch;

  while ((attrMatch = attrRegex.exec(attrsText)) !== null) {
    const key = attrMatch[1];
    let rawValue = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';

    // 处理属性值里包含未转义双引号的情况
    // 例如 follow_up="[{ "text": "xxx" }]"，正则只会匹配到 [{ 
    // 如果发现后面还有内容且当前匹配不完整，尝试贪心扩展
    rawValue = greedyFixQuotedValue(attrsText, attrMatch.index + attrMatch[0].indexOf('=') + 1, rawValue);

    result[key] = normalizeXmlAttributeValue(decodeXmlEntities(rawValue));
  }

  return result;
}

// 当属性值里包含未转义引号时，贪心扩展找到真正的结束位置
function greedyFixQuotedValue(attrsText, valueStartIndex, initialValue) {
  const rest = attrsText.slice(valueStartIndex).trim();

  // 找到开头引号
  const firstQuote = rest.match(/^["']/);
  if (!firstQuote) return initialValue;

  const quote = firstQuote[0];
  let depth = 0;
  let inString = false;
  let stringQuote = null;

  for (let i = 1; i < rest.length; i++) {
    const char = rest[i];
    const prev = rest[i - 1];

    if (!inString) {
      if (char === '{' || char === '[') {
        depth++;
      } else if (char === '}' || char === ']') {
        depth--;
      } else if (char === quote && depth === 0) {
        // 找到属性值的真正结束引号
        return rest.slice(1, i);
      }
    }

    // 处理字符串内部引号（JSON 风格）
    if (char === '"' || char === "'") {
      if (!inString) {
        inString = true;
        stringQuote = char;
      } else if (char === stringQuote && prev !== '\\') {
        inString = false;
        stringQuote = null;
      }
    }
  }

  return initialValue;
}

function normalizeXmlAttributeValue(value) {
  if (value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

function buildToolCall(index, toolName, argumentsParsed, customId) {
  return {
    id: customId || `xml_tool_call_${Date.now()}_${index}`,
    type: 'function',
    function: {
      name: toolName,
      arguments: normalizeToolArguments(toolName, argumentsParsed)
    }
  };
}

function stripToolCallWrapper(text) {
  return String(text || '')
    .replace(/^\s*<function_calls>\s*/i, '')
    .replace(/\s*<\/function_calls>\s*$/i, '')
    .replace(/^\s*\[function_calls\]\s*/i, '')
    .replace(/\s*\[\/function_calls\]\s*$/i, '')
    .replace(/^\s*\[tool_calls\]\s*/i, '')
    .replace(/\s*\[\/tool_calls\]\s*$/i, '');
}

function decodeXmlEntities(value) {
  // 解码 XML/HTML 实体，避免工具参数里的实体文本残留在最终 arguments 里
  // & 必须最后解码，否则会把其他实体提前拆坏
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function normalizeToolArguments(toolName, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;

  const result = { ...args };

  // ask_followup_question.follow_up 必须是合法 JSON 字符串
  // 模型常把它输出成 XML 属性，解码后需要重新规范成 JSON 文本
  if (toolName === 'ask_followup_question' && typeof result.follow_up === 'string') {
    const fixed = tryNormalizeJsonText(result.follow_up);
    if (fixed) result.follow_up = fixed;
  }

  return result;
}

function tryNormalizeJsonText(value) {
  const text = String(value || '').trim();
  if (!text) return value;

  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(parsed);
  } catch {
    return value;
  }
}

function shouldSkipContainerTag(tagName) {
  const lowered = String(tagName || '').toLowerCase();
  return lowered === 'function_calls' || lowered === 'function_results' || lowered === 'arguments' || lowered === 'name';
}

function dedupeToolCalls(toolCalls) {
  const seen = new Set();
  const result = [];

  for (const toolCall of toolCalls) {
    const key = `${toolCall.function.name}:${JSON.stringify(toolCall.function.arguments)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(toolCall);
  }

  return result;
}

// 从 assistant 文本中提取所有 XML tool calls
function parseXmlToolCallsFromText(text) {
  if (!hasFunctionCalls(text)) return [];

  const blocks = extractFunctionCallsBlocks(text);
  const allCalls = [];

  for (const block of blocks) {
    const calls = parseFunctionCallsBlock(block);
    allCalls.push(...calls);
  }

  return allCalls;
}

// 检测文本是否包含 JSON 工具调用（模型有时会输出 JSON 而不是 XML）
function hasJsonToolCall(text) {
  if (typeof text !== 'string') return false;
  // 查找顶层 JSON 对象，包含工具相关的 key
  return /^\s*\{\s*"(?:command|name|action|tool|function|file_path|content|url|path|query|text)"/m.test(text);
}

// 从文本中提取 JSON 工具调用
function parseJsonToolCallsFromText(text) {
  if (typeof text !== 'string') return [];

  const toolCalls = [];
  // 匹配顶层 JSON 对象
  const jsonRegex = /\{(?:[^{}]|(?:\{(?:[^{}]|(?:\{[^{}]*\}))*\}))*\}/g;
  let jsonMatch;

  while ((jsonMatch = jsonRegex.exec(text)) !== null) {
    const raw = jsonMatch[0];
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;

    // 检查是否包含工具相关的 key
    const toolKeys = ['command', 'name', 'action', 'tool', 'function', 'file_path', 'content', 'url', 'path', 'query', 'text'];
    const hasToolKey = toolKeys.some((key) => key in parsed);
    if (!hasToolKey) continue;

    // 推断工具名
    const toolName = inferToolName(parsed);

    // 移除 tool 名相关的 key，剩下的作为 arguments
    const args = { ...parsed };
    delete args._tool_name;

    toolCalls.push(buildToolCall(toolCalls.length, toolName, args));
  }

  return toolCalls;
}

// 根据 JSON 参数推断工具名
function inferToolName(args) {
  if (!args || typeof args !== 'object') return 'unknown_tool';

  // 按 key 特征匹配已知工具
  if ('command' in args) return 'execute_command';
  if ('file_path' in args || 'content' in args) return 'write_file';
  if ('url' in args) return 'fetch_url';
  if ('path' in args || 'query' in args) return 'search_files';
  if ('text' in args) return 'ask_followup_question';

  // 如果有 name 字段，用它作为工具名
  if (typeof args.name === 'string' && args.name.trim()) {
    const name = args.name.trim();
    delete args.name;
    args._tool_name = name;
    return name;
  }

  return 'unknown_tool';
}

// 把 XML function_calls 转成可读文本块（用于聊天输入）
function buildXmlToolCallText(text) {
  const toolCalls = parseXmlToolCallsFromText(text);
  if (!toolCalls.length) return '';

  const blocks = [];
  for (const toolCall of toolCalls) {
    const lines = ['[tool_calls]'];
    lines.push(`- id: ${toolCall.id}`);
    lines.push(`- name: ${toolCall.function.name}`);
    lines.push(`- arguments: ${JSON.stringify(toolCall.function.arguments)}`);
    blocks.push(lines.join('\n'));
  }

  return blocks.join('\n\n').trim();
}

// 从 assistant 文本中剥离 XML / 方括号工具标签，只保留纯文本
function stripXmlToolCalls(text) {
  if (typeof text !== 'string') return text || '';

  // 第 1 步：去掉容器标签
  let result = text
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '')
    .replace(/<function_results>[\s\S]*?<\/function_results>/gi, '')
    .replace(/\[function_calls\][\s\S]*?\[\/function_calls\]/gi, '')
    .replace(/\[tool_calls\][\s\S]*?\[\/tool_calls\]/gi, '')
    .replace(/<invoke\s+tool_name="[^"]*"\s*>[\s\S]*?<\/invoke>/gi, '')
    .replace(/<function_call\s*>[\s\S]*?<\/function_call>/gi, '');

  // 第 2 步：去掉常见工具自闭合标签（如 <execute_command ... />）
  // 这些标签通常在 <function_calls> 内部，但上一步可能只去掉了外层容器
  result = result.replace(/<[a-z_][a-z0-9_-]*\b[^<>]*\/>/gi, '');

  return result.trim();
}

// 检测文本是否包含 <function_results> 块
function hasFunctionResults(text) {
  if (typeof text !== 'string') return false;
  return /<function_results>[\s\S]*?<\/function_results>/i.test(text);
}

// 从文本中提取 function_results 内容
function extractFunctionResults(text) {
  if (typeof text !== 'string') return '';
  const match = text.match(/<function_results>([\s\S]*?)<\/function_results>/i);
  return match ? match[1].trim() : '';
}

// 解析 [tool_calls] 文本格式（Roo Code 风格）
// 格式示例：
//   [tool_calls]
//   - id: xxx
//   - name: execute_command
//   - arguments: {"command":"git status"}
function parseTextToolCalls(text) {
  if (typeof text !== 'string') return [];

  const toolCalls = [];
  const blockRegex = /^\[tool_calls\]\s*\n([\s\S]*?)(?=\n\[tool_calls\]|\n\[\/tool_calls\]|$)/gim;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(text)) !== null) {
    const block = blockMatch[1];
    const id = extractTextToolCallField(block, 'id');
    const name = extractTextToolCallField(block, 'name');
    const argsText = extractTextToolCallField(block, 'arguments');

    if (!name) continue;

    let argsParsed = {};
    if (argsText) {
      try {
        argsParsed = JSON.parse(argsText);
      } catch {
        argsParsed = { raw: argsText };
      }
    }

    toolCalls.push(buildToolCall(toolCalls.length, name, argsParsed, id));
  }

  return toolCalls;
}

function extractTextToolCallField(block, fieldName) {
  const regex = new RegExp(`^-\\s*${fieldName}\\s*:\\s*(.*)$`, 'im');
  const match = block.match(regex);
  return match ? match[1].trim() : '';
}

module.exports = {
  hasFunctionCalls,
  hasFunctionCallOpenTag,
  extractFunctionCallsBlocks,
  parseFunctionCallsBlock,
  parseXmlToolCallsFromText,
  buildXmlToolCallText,
  stripXmlToolCalls,
  hasFunctionResults,
  extractFunctionResults,
  hasJsonToolCall,
  parseJsonToolCallsFromText,
  parseTextToolCalls
};
