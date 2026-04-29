// ============================================
// XML Function Calling 支持
// 将 OpenAI tools 转换为 XML 格式提示词
// ============================================

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

    const name = func.name || 'unknown';
    const description = func.description || '';
    const params = func.parameters || {};

    prompt += `## ${name}\n`;
    if (description) prompt += `${description}\n\n`;

    if (params.type === 'object' && params.properties) {
      const required = Array.isArray(params.required) ? params.required : [];

      prompt += '参数：\n';
      for (const [paramName, paramDef] of Object.entries(params.properties)) {
        const isRequired = required.includes(paramName);
        const typeStr = paramDef.type || 'any';
        const descStr = paramDef.description ? ` — ${paramDef.description}` : '';
        const reqStr = isRequired ? '（必需）' : '（可选）';
        prompt += `- ${paramName}: ${typeStr}${reqStr}${descStr}\n`;
      }
      prompt += '\n';
    }
  }

  prompt += '\n## 使用格式\n\n';
  prompt += '当你需要使用工具时，请按以下 XML 格式输出：\n\n';
  prompt += '<function_calls>\n';
  prompt += '<invoke name="use_tool">\n';
  prompt += '<parameter name="tool_name">工具名称</parameter>\n';
  prompt += '<parameter name="arguments">{"key": "value"}</parameter>\n';
  prompt += '</invoke>\n';
  prompt += '</function_calls>\n\n';
  prompt += '工具执行结果将以 <function_results> 标签返回。\n\n';
  prompt += '## 重要规则\n\n';
  prompt += '1. 每次只能调用一个工具\n';
  prompt += '2. 等待工具执行结果后再进行下一步\n';
  prompt += '3. 如果工具执行失败，向用户说明原因\n';
  prompt += '4. 不要重复调用相同的工具\n';
  prompt += '5. 如果不需要工具，直接回答用户问题\n';

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

// 构建 XML 格式的 inputs
function buildXMLInputs(systemPrompt, userInput, allMessages) {
  // 过滤掉 system 消息
  const filteredMessages = allMessages.filter(m => m.role !== 'system');

  // 构建历史对话上下文（不包括最后一条 user 消息）
  let history = '';
  const lastUserIndex = filteredMessages.map(m => m.role).lastIndexOf('user');

  for (let i = 0; i < filteredMessages.length; i++) {
    const msg = filteredMessages[i];

    // 跳过最后一条 user 消息
    if (msg.role === 'user' && i === lastUserIndex) {
      continue;
    }

    if (msg.role === 'user') {
      history += `<|user|>\n${msg.content}\n<|end|>\n`;
    } else if (msg.role === 'assistant') {
      history += `<|assistant|>\n${msg.content}\n<|end|>\n`;
    } else if (msg.role === 'tool') {
      history += `<|user|>\n<function_results>\n${msg.content}\n</function_results>\n<|end|>\n`;
    }
  }

  return `<|system|>\n${systemPrompt}\n<|end|>\n${history}<|user|>\n${userInput}\n<|end|>\n<|assistant|>`;
}

// 解析 XML 格式的工具调用
// 支持两种格式：
// 1. Fitten Code 原生: <invoke name="tool_name"><parameter name="arg">value</parameter>...</invoke>
// 2. 提示词格式: <invoke name="use_tool"><parameter name="tool_name">name</parameter><parameter name="arguments">{...}</parameter></invoke>
function parseToolCallXML(content) {
  if (typeof content !== 'string') return null;

  // 提取 <function_calls>...</function_calls> 之间的内容
  const functionCallsMatch = content.match(/<function_calls>([\s\S]*?)<\/function_calls>/);
  if (!functionCallsMatch) return null;

  const innerContent = functionCallsMatch[1];

  // 匹配 <invoke name="...">
  const invokeMatch = innerContent.match(/<invoke name="([^"]+)">/);
  if (!invokeMatch) return null;

  const invokeType = invokeMatch[1].trim();

  // 提取 invoke 标签内的内容（从第一个 <parameter> 开始到 </invoke> 或字符串结束）
  const invokeStart = innerContent.indexOf('<parameter');
  const invokeEnd = innerContent.indexOf('</invoke>');

  let invokeContent;
  if (invokeEnd === -1) {
    invokeContent = innerContent.substring(invokeStart);
  } else {
    invokeContent = innerContent.substring(invokeStart, invokeEnd);
  }

  // 手动解析参数（处理可能缺少 </parameter> 的情况）
  const args = {};
  const paramRegex = /<parameter name="([^"]+)">/g;
  const paramPositions = [];

  // 找到所有参数标签的位置
  let paramMatch;
  while ((paramMatch = paramRegex.exec(invokeContent)) !== null) {
    paramPositions.push({
      name: paramMatch[1],
      start: paramMatch.index + paramMatch[0].length
    });
  }

  // 提取每个参数的值
  for (let i = 0; i < paramPositions.length; i++) {
    const param = paramPositions[i];
    const nextParamStart = i < paramPositions.length - 1
      ? paramPositions[i + 1].start - `<parameter name="${paramPositions[i + 1].name}">`.length
      : invokeContent.length;
    let value = invokeContent.substring(param.start, nextParamStart).trim();

    // 移除可能的 </parameter> 标签
    value = value.replace(/<\/parameter>\s*$/, '').trim();

    // 尝试解析 JSON，失败则保留字符串
    try {
      args[param.name] = JSON.parse(value);
    } catch {
      args[param.name] = value;
    }
  }

  // 如果是 use_tool 格式，提取 tool_name 和 arguments
  if (invokeType === 'use_tool') {
    const toolName = args.tool_name;
    let toolArgs = args.arguments;

    // 如果 arguments 是字符串，尝试解析为 JSON
    // Fitten Code 返回的 JSON 可能包含未转义的换行符，需要先修复
    if (typeof toolArgs === 'string') {
      try {
        toolArgs = JSON.parse(toolArgs);
      } catch {
        // JSON 解析失败，可能是包含未转义的换行符
        // 尝试修复：将实际换行符转义为 \n
        try {
          const fixedJson = toolArgs.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
          toolArgs = JSON.parse(fixedJson);
        } catch {
          // 修复后仍然失败，保持原字符串
        }
      }
    }

    return {
      tool_name: toolName,
      arguments: toolArgs
    };
  }

  // Fitten Code 原生格式
  return {
    tool_name: invokeType,
    arguments: args
  };
}

// 检测是否是工具调用格式
function isToolCallFormat(content) {
  if (typeof content !== 'string') return false;
  return content.includes('<function_calls>') && content.includes('<invoke');
}

// 解析 Agent 响应（用于非流式）
function parseAgentResponse(events, tools) {
  const result = {
    content: '',
    toolCalls: []
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
    const toolCall = parseToolCallXML(fullContent);
    if (toolCall) {
      // 找到对应的工具定义
      const toolDef = tools.find(t => t.function?.name === toolCall.tool_name);
      if (toolDef) {
        result.toolCalls.push({
          id: `call_${Math.random().toString(36).substring(2, 15)}`,
          type: 'function',
          function: {
            name: toolCall.tool_name,
            arguments: typeof toolCall.arguments === 'string'
              ? toolCall.arguments
              : JSON.stringify(toolCall.arguments)
          }
        });
      }
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
  parseToolCallXML
};
