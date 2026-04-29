const crypto = require('crypto');

// ============================================
// XML Function Calling 支持
// 将 OpenAI tools 转换为 XML 格式提示词
// ============================================

// 生成 call id（使用 crypto.randomUUID）
function generateCallId() {
  return `call_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`;
}

// 构建 XML function calling 的 payload
function buildAgentPayload(messages, tools, session, options = {}) {
  const { sessionId = '' } = options;

  // 构建 system prompt（包含 XML 工具说明）
  const systemPrompt = buildXMLToolsPrompt(tools);

  // 构建用户输入
  const userInput = extractLastUserMessage(messages);

  // 构建特殊的 inputs 格式
  const inputs = buildXMLInputs(systemPrompt, userInput, messages);

  return {
    inputs,
    ft_token: session.userId,
    session_id: sessionId
  };
}

// 构建 XML 格式的 tools 提示词
function buildXMLToolsPrompt(tools) {
  let prompt = '# 工具使用指南\n\n';
  prompt += '你可以使用以下工具来协助用户：\n\n';

  for (const tool of tools) {
    const func = tool.function;
    if (!func) continue;

    const name = escapeXML(func.name || 'unknown');
    const description = escapeXML(func.description || '');
    const params = func.parameters || {};

    prompt += `## ${name}\n`;
    if (description) prompt += `${description}\n\n`;

    if (params.type === 'object' && params.properties) {
      const required = Array.isArray(params.required) ? params.required : [];

      prompt += '参数：\n';
      for (const [paramName, paramDef] of Object.entries(params.properties)) {
        const safeParamName = escapeXML(paramName);
        const isRequired = required.includes(paramName);
        const typeStr = escapeXML(paramDef.type || 'any');
        const descStr = paramDef.description ? ` — ${escapeXML(paramDef.description)}` : '';
        const reqStr = isRequired ? '（必需）' : '（可选）';
        prompt += `- ${safeParamName}: ${typeStr}${reqStr}${descStr}\n`;
      }
      prompt += '\n';
    }
  }

  prompt += '\n## 使用格式\n\n';
  prompt += '当你需要使用工具时，请按以下 XML 格式输出：\n\n';
  prompt += '<function_calls>\n';
  prompt += '  <invoke name="use_tool">\n';
  prompt += '    <parameter name="tool_name">工具名称</parameter>\n';
  prompt += '    <parameter name="arguments">{"key": "value"}</parameter>\n';
  prompt += '  </invoke>\n';
  prompt += '</function_calls>\n\n';
  prompt += '工具执行结果将以 <function_results> 标签返回。\n\n';
  prompt += '## 重要规则\n\n';
  prompt += '1. 可以同时调用多个工具，每个工具用一个 <invoke> 标签\n';
  prompt += '2. 所有工具调用都放在同一个 <function_calls> 块中\n';
  prompt += '3. 如果工具执行失败，向用户说明原因\n';
  prompt += '4. 如果不需要工具，直接回答用户问题\n';

  return prompt;
}

// 提取最后一条用户消息
function extractLastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return messages[i].content;
    }
  }
  return '';
}

// 转义 XML 特殊字符，防止 prompt 注入
function escapeXML(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// 转义特殊标签，防止污染 XML 结构
function escapeSpecialTags(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<\|system\|>/gi, '&lt;|system|&gt;')
    .replace(/<\|user\|>/gi, '&lt;|user|&gt;')
    .replace(/<\|assistant\|>/gi, '&lt;|assistant|&gt;')
    .replace(/<\|end\|>/gi, '&lt;|end|&gt;')
    .replace(/<function_calls>/gi, '&lt;function_calls&gt;')
    .replace(/<\/function_calls>/gi, '&lt;/function_calls&gt;')
    .replace(/<function_results>/gi, '&lt;function_results&gt;')
    .replace(/<\/function_results>/gi, '&lt;/function_results&gt;')
    .replace(/<invoke/gi, '&lt;invoke')
    .replace(/<\/invoke>/gi, '&lt;/invoke&gt;')
    .replace(/<parameter/gi, '&lt;parameter')
    .replace(/<\/parameter>/gi, '&lt;/parameter&gt;');
}

// 安全地准备用户内容
function sanitizeUserContent(content) {
  // 先转义特殊标签，再转义 XML 实体
  return escapeXML(escapeSpecialTags(content));
}

// 角色映射表：OpenAI 角色 -> Fitten Code 支持的角色
// Fitten Code 只支持: system, user, assistant
const ROLE_MAPPING = {
  'system': 'system',
  'developer': 'system',     // developer 映射到 system
  'user': 'user',
  'assistant': 'assistant',
  'tool': 'user',            // tool 结果作为 user 消息
  'function': 'user'         // function 结果也作为 user 消息
};

// 获取消息角色（归一化到 Fitten Code 支持的角色）
function getMessageRole(msg) {
  if (!msg || typeof msg.role !== 'string') {
    console.warn('[Agent Mode] Missing or invalid role, treating as user');
    return 'user';
  }

  const role = msg.role.toLowerCase().trim();

  // 优先使用映射后的角色
  const mappedRole = ROLE_MAPPING[role];
  if (mappedRole) return mappedRole;

  // 未知角色默认作为 user（安全降级）
  console.warn(`[Agent Mode] Unknown role "${msg.role}", treating as user`);
  return 'user';
}

// 构建 XML 格式的 inputs
function buildXMLInputs(systemPrompt, userInput, allMessages) {
  // 收集所有 system/developer 消息
  const systemMessages = allMessages.filter(m => m.role === 'system' || m.role === 'developer');
  const otherMessages = allMessages.filter(m => m.role !== 'system' && m.role !== 'developer');

  // 合并 system 消息
  let finalSystemPrompt = systemPrompt;
  if (systemMessages.length > 0) {
    const additionalSystem = systemMessages.map(m => m.content).join('\n\n');
    finalSystemPrompt = `${systemPrompt}\n\n${additionalSystem}`;
  }

  // 构建历史对话上下文（不包括最后一条 user 消息）
  let history = '';
  const lastUserIndex = otherMessages.map(m => m.role).lastIndexOf('user');

  for (let i = 0; i < otherMessages.length; i++) {
    const msg = otherMessages[i];
    const role = getMessageRole(msg);

    // 跳过最后一条 user 消息
    if (role === 'user' && i === lastUserIndex) {
      continue;
    }

    if (role === 'user') {
      history += `<|user|>\n${sanitizeUserContent(msg.content)}\n<|end|>\n`;
    } else if (role === 'assistant') {
      history += `<|assistant|>\n${sanitizeUserContent(msg.content)}\n<|end|>\n`;
    } else if (msg.role === 'tool' || msg.role === 'function') {
      // tool/function 消息的内容需要包装在 function_results 中
      const safeContent = sanitizeUserContent(msg.content);
      history += `<|user|>\n<function_results>\n${safeContent}\n</function_results>\n<|end|>\n`;
    }
  }

  return `<|system|>\n${finalSystemPrompt}\n<|end|>\n${history}<|user|>\n${sanitizeUserContent(userInput)}\n<|end|>\n<|assistant|>`;
}

// 解析 XML 格式的工具调用（支持多个工具）
// 支持两种格式：
// 1. Fitten Code 原生: <invoke name="tool_name"><parameter name="arg">value</parameter>...</invoke>
// 2. 提示词格式: <invoke name="use_tool"><parameter name="tool_name">name</parameter><parameter name="arguments">{...}</parameter></invoke>
function parseToolCallXML(content) {
  if (typeof content !== 'string') return null;

  // 解析所有工具调用
  const toolCalls = parseAllToolCalls(content);
  if (!toolCalls || toolCalls.length === 0) return null;

  // 为了向后兼容，返回第一个工具调用
  // 调用方应该使用 parseAllToolCalls 获取所有工具
  return toolCalls[0];
}

// 解析所有工具调用（支持多个）
function parseAllToolCalls(content) {
  if (typeof content !== 'string') return null;

  // 找到 <function_calls> 标签
  const startIdx = content.indexOf('<function_calls>');
  const endIdx = content.indexOf('</function_calls>');

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null;
  }

  const xmlContent = content.substring(startIdx + '<function_calls>'.length, endIdx);
  const toolCalls = [];

  // 查找所有 <invoke> 标签
  let pos = 0;
  while (pos < xmlContent.length) {
    const invokeStart = xmlContent.indexOf('<invoke', pos);
    if (invokeStart === -1) break;

    const invokeEnd = xmlContent.indexOf('</invoke>', invokeStart);
    if (invokeEnd === -1) break;

    const invokeContent = xmlContent.substring(invokeStart, invokeEnd + '</invoke>'.length);
    const toolCall = parseSingleInvoke(invokeContent);

    if (toolCall) {
      toolCalls.push(toolCall);
    }

    pos = invokeEnd + '</invoke>'.length;
  }

  return toolCalls.length > 0 ? toolCalls : null;
}

// 解析单个 <invoke> 标签
function parseSingleInvoke(invokeContent) {
  // 解析 <invoke name="...">
  const invokeMatch = invokeContent.match(/<invoke\s+name="([^"]+)"\s*>/);
  if (!invokeMatch) return null;

  const invokeType = invokeMatch[1].trim();

  // 找到 invoke 标签内的参数内容
  const paramStart = invokeContent.indexOf('<parameter');
  const invokeEnd = invokeContent.indexOf('</invoke>');

  if (paramStart === -1 || invokeEnd === -1) return null;

  const paramsContent = invokeContent.substring(paramStart, invokeEnd);

  // 解析所有参数
  const parameters = parseParameters(paramsContent);

  // 如果是 use_tool 格式
  if (invokeType === 'use_tool') {
    const toolName = parameters.tool_name;
    let toolArgs = parameters.arguments;

    if (typeof toolArgs === 'string') {
      toolArgs = parseJSONWithRepair(toolArgs);
    }

    return {
      tool_name: toolName,
      arguments: toolArgs
    };
  }

  // Fitten Code 原生格式
  const args = {};
  for (const [key, value] of Object.entries(parameters)) {
    args[key] = parseJSONWithRepair(value);
  }

  return {
    tool_name: invokeType,
    arguments: args
  };
}

// 解析参数
function parseParameters(paramsContent) {
  const parameters = {};
  let pos = 0;

  while (pos < paramsContent.length) {
    // 查找 <parameter name="...">
    const paramStart = paramsContent.indexOf('<parameter', pos);
    if (paramStart === -1) break;

    const nameMatch = paramsContent.substring(paramStart).match(/^<parameter\s+name="([^"]+)"\s*>/);
    if (!nameMatch) {
      pos = paramStart + 1;
      continue;
    }

    const paramName = nameMatch[1];
    const valueStart = paramStart + nameMatch[0].length;

    // 查找参数值结束位置
    let valueEnd = paramsContent.indexOf('</parameter>', valueStart);

    if (valueEnd === -1) {
      // 没有闭合标签，查找下一个参数开始或字符串结束
      const nextParam = paramsContent.indexOf('<parameter', valueStart);
      valueEnd = nextParam !== -1 ? nextParam : paramsContent.length;
    }

    let value = paramsContent.substring(valueStart, valueEnd).trim();
    value = decodeXMLEntities(value);
    parameters[paramName] = value;

    pos = valueEnd + (paramsContent.indexOf('</parameter>', valueStart) === valueEnd ? '</parameter>'.length : 0);
  }

  return parameters;
}

// 使用状态机解析 XML
function parseXMLWithStateMachine(content) {
  // 找到 <function_calls> 标签
  const startIdx = content.indexOf('<function_calls>');
  const endIdx = content.indexOf('</function_calls>');

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null;
  }

  const xmlContent = content.substring(startIdx + '<function_calls>'.length, endIdx);

  // 解析 <invoke name="...">
  const invokeMatch = xmlContent.match(/<invoke\s+name="([^"]+)"\s*>/);
  if (!invokeMatch) return null;

  const invokeType = invokeMatch[1].trim();

  // 找到 invoke 标签内的内容
  const invokeStart = xmlContent.indexOf('<parameter');
  const invokeEnd = xmlContent.indexOf('</invoke>');

  if (invokeStart === -1) return null;

  const paramsContent = invokeEnd > invokeStart
    ? xmlContent.substring(invokeStart, invokeEnd)
    : xmlContent.substring(invokeStart);

  // 使用状态机解析参数
  const parameters = {};
  let pos = 0;

  while (pos < paramsContent.length) {
    // 查找 <parameter name="...">
    const paramStart = paramsContent.indexOf('<parameter', pos);
    if (paramStart === -1) break;

    const nameMatch = paramsContent.substring(paramStart).match(/^<parameter\s+name="([^"]+)"\s*>/);
    if (!nameMatch) {
      pos = paramStart + 1;
      continue;
    }

    const paramName = nameMatch[1];
    const valueStart = paramStart + nameMatch[0].length;

    // 查找参数值结束位置
    // 优先查找 </parameter>，如果不存在则查找下一个 <parameter 或 </invoke>
    let valueEnd = paramsContent.indexOf('</parameter>', valueStart);

    if (valueEnd === -1) {
      // 没有闭合标签，查找下一个参数开始或字符串结束
      const nextParam = paramsContent.indexOf('<parameter', valueStart);
      const invokeClose = paramsContent.indexOf('</invoke>', valueStart);

      if (nextParam !== -1 && (invokeClose === -1 || nextParam < invokeClose)) {
        valueEnd = nextParam;
      } else if (invokeClose !== -1) {
        valueEnd = invokeClose;
      } else {
        valueEnd = paramsContent.length;
      }
    }

    let value = paramsContent.substring(valueStart, valueEnd).trim();

    // 解码 XML 实体
    value = decodeXMLEntities(value);

    parameters[paramName] = value;
    pos = valueEnd + (paramsContent.indexOf('</parameter>', valueStart) === valueEnd ? '</parameter>'.length : 0);
  }

  return { invokeType, parameters };
}

// 解码 XML 实体
function decodeXMLEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// 尝试解析 JSON，失败时尝试修复
function parseJSONWithRepair(value) {
  if (typeof value !== 'string') return value;

  // 先尝试直接解析
  try {
    return JSON.parse(value);
  } catch {
    // 直接解析失败，尝试修复
  }

  // 修复常见的 JSON 问题
  let repaired = value;

  // 1. 处理未转义的换行符、回车符、制表符
  // 只替换不在字符串值中的控制字符
  repaired = repaired.replace(/(?<!\\)\n/g, '\\n');
  repaired = repaired.replace(/(?<!\\)\r/g, '\\r');
  repaired = repaired.replace(/(?<!\\)\t/g, '\\t');

  // 2. 处理未转义的双引号（在字符串值中）
  // 这个比较复杂，暂时不处理，避免破坏合法 JSON

  // 3. 尝试解析修复后的 JSON
  try {
    return JSON.parse(repaired);
  } catch {
    // 修复失败，返回原始字符串
    // 记录警告日志，方便调试
    console.warn('[Agent Mode] JSON parse failed, returning raw string:', value.substring(0, 100));
    return value;
  }
}

// 检测是否是工具调用格式
// 检测是否是工具调用格式
// 注意：要严格检测，避免把用户输入中的 XML 标签误判为工具调用
function isToolCallFormat(content) {
  if (typeof content !== 'string') return false;

  // 必须包含完整的 <function_calls> 块
  const hasFunctionCalls = content.includes('<function_calls>') && content.includes('</function_calls>');
  const hasInvoke = content.includes('<invoke') && content.includes('</invoke>');

  if (!hasFunctionCalls || !hasInvoke) {
    return false;
  }

  // 额外检查：确保 <function_calls> 在 <invoke> 之前（模型输出格式）
  const funcCallsStart = content.indexOf('<function_calls>');
  const invokeStart = content.indexOf('<invoke');

  // invoke 必须在 function_calls 块内
  if (invokeStart <= funcCallsStart) {
    return false;
  }

  // 检查是否包含参数标签（模型输出会有 parameter 标签）
  const hasParameter = content.includes('<parameter');

  return hasParameter;
}

// 校验工具参数是否符合 schema
function validateToolArguments(args, toolDef) {
  const errors = [];
  const schema = toolDef.function?.parameters;

  if (!schema || typeof schema !== 'object') {
    return { valid: true, errors: [] };
  }

  // 检查 required 字段
  if (Array.isArray(schema.required)) {
    for (const reqField of schema.required) {
      if (!(reqField in args)) {
        errors.push(`缺少必需参数: ${reqField}`);
      }
    }
  }

  // 检查每个参数的 type
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [key, value] of Object.entries(args)) {
      const propDef = schema.properties[key];
      if (!propDef) {
        // 检查 additionalProperties
        if (schema.additionalProperties === false) {
          errors.push(`未知参数: ${key}`);
        }
        continue;
      }

      // 校验类型
      if (propDef.type) {
        const valid = validateType(value, propDef.type, propDef);
        if (!valid) {
          errors.push(`参数 ${key} 类型错误: 期望 ${propDef.type}, 实际 ${typeof value}`);
        }
      }

      // 校验 enum
      if (Array.isArray(propDef.enum)) {
        if (!propDef.enum.includes(value)) {
          errors.push(`参数 ${key} 值错误: 必须是 ${propDef.enum.join(' / ')} 之一`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

// 校验单个值的类型
function validateType(value, expectedType, propDef) {
  switch (expectedType) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && !isNaN(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

// 解析 Agent 响应（用于非流式）
function parseAgentResponse(events, tools) {
  const result = {
    content: '',
    toolCalls: [],
    parseError: null
  };

  // 收集所有内容
  let fullContent = '';
  for (const event of events) {
    if (typeof event.delta === 'string') {
      fullContent += event.delta;
    }
  }

  // 检查是否是工具调用格式
  if (isToolCallFormat(fullContent)) {
    // 解析所有工具调用（支持多个）
    const allToolCalls = parseAllToolCalls(fullContent);

    if (allToolCalls && allToolCalls.length > 0) {
      const parseErrors = [];

      for (const toolCall of allToolCalls) {
        // 找到对应的工具定义
        const toolDef = tools.find(t => t.function?.name === toolCall.tool_name);
        if (!toolDef) {
          parseErrors.push(`未知工具: ${toolCall.tool_name}`);
          continue;
        }

        // 校验参数
        const args = typeof toolCall.arguments === 'string'
          ? toolCall.arguments
          : JSON.stringify(toolCall.arguments);

        const validation = validateToolArguments(
          typeof toolCall.arguments === 'object' ? toolCall.arguments : JSON.parse(args),
          toolDef
        );

        if (!validation.valid) {
          parseErrors.push(`工具 ${toolCall.tool_name} 参数校验失败: ${validation.errors.join(', ')}`);
          continue;
        }

        result.toolCalls.push({
          id: generateCallId(),
          type: 'function',
          function: {
            name: toolCall.tool_name,
            arguments: args
          }
        });
      }

      // 如果有解析错误，记录但继续返回成功解析的工具
      if (parseErrors.length > 0) {
        result.parseError = parseErrors.join('; ');
      }

      // 如果没有成功解析任何工具，返回普通文本
      if (result.toolCalls.length === 0) {
        result.content = fullContent;
      }
    } else {
      result.parseError = 'XML 解析失败';
      result.content = fullContent;
    }
  } else {
    // 普通文本响应
    result.content = fullContent;
  }

  return result;
}

module.exports = {
  buildAgentPayload,
  buildXMLToolsPrompt,
  buildXMLInputs,
  parseAgentResponse,
  isToolCallFormat,
  parseToolCallXML,
  parseAllToolCalls,
  validateToolArguments
};
