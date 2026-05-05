/**
 * tool_calls 协议翻译验证脚本。
 *
 * 测试内容：
 *   1. buildOpenAiResponse() — XML → OpenAI tool_calls 转换
 *   2. buildOpenAiToolCalls() — 格式正确性
 *   3. 流式增量格式 — writeToolCallsIncremental
 *   4. 边界情况 — 无 XML、多个 tool call、空 arguments
 *
 * 用法：
 *   node scripts/check-tool-calls.js
 */

const { parseXmlToolCallsFromText, hasFunctionCalls, stripXmlToolCalls, hasJsonToolCall, parseJsonToolCallsFromText } = require('../src/parse-xml-tool-calls');

// ============================================
// 模拟 index.js 中的转换函数
// ============================================

// 把 XML tool calls 转成 OpenAI 标准 tool_calls 格式
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

// 构建 OpenAI 兼容响应
function buildOpenAiResponse(model, content, events) {
  let toolCalls = hasFunctionCalls(content) ? parseXmlToolCallsFromText(content) : [];
  if (toolCalls.length === 0 && hasJsonToolCall(content)) {
    toolCalls = parseJsonToolCallsFromText(content);
  }
  const cleanContent = hasFunctionCalls(content) ? stripXmlToolCalls(content) : content;

  const message = { role: 'assistant', content: cleanContent || '' };
  if (toolCalls.length > 0) message.tool_calls = buildOpenAiToolCalls(toolCalls);

  return {
    id: `chatcmpl-test`,
    object: 'chat.completion',
    created: 1700000000,
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
    }]
  };
}

// ============================================
// 测试
// ============================================

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed += 1;
  } else {
    console.log(`  ❌ ${name}: ${detail}`);
    failed += 1;
  }
}

console.log('========================================');
console.log('  tool_calls 协议翻译验证脚本');
console.log('========================================\n');

// ============================================
// 第 1 部分：buildOpenAiToolCalls 格式
// ============================================

console.log('===== 第 1 部分：buildOpenAiToolCalls 格式 =====\n');

const rawToolCalls = [
  {
    id: 'xml_call_0',
    type: 'function',
    function: { name: 'run_terminal', arguments: { command: 'ls -la' } }
  },
  {
    id: 'xml_call_1',
    type: 'function',
    function: { name: 'read_file', arguments: { file_path: '/tmp/test.txt' } }
  }
];

const openAiCalls = buildOpenAiToolCalls(rawToolCalls);

check('返回数组长度 2', openAiCalls.length === 2, `got ${openAiCalls.length}`);
check('第 1 个 index 为 0', openAiCalls[0].index === 0, `got ${openAiCalls[0].index}`);
check('第 1 个 id 正确', openAiCalls[0].id === 'xml_call_0', `got ${openAiCalls[0].id}`);
check('第 1 个 type 为 function', openAiCalls[0].type === 'function', `got ${openAiCalls[0].type}`);
check('第 1 个 function.name 正确', openAiCalls[0].function.name === 'run_terminal', `got ${openAiCalls[0].function.name}`);
check('第 1 个 function.arguments 是 JSON 字符串', typeof openAiCalls[0].function.arguments === 'string', `got ${typeof openAiCalls[0].function.arguments}`);
check('第 1 个 arguments 内容正确', openAiCalls[0].function.arguments === '{"command":"ls -la"}', `got ${openAiCalls[0].function.arguments}`);
check('第 2 个 index 为 1', openAiCalls[1].index === 1, `got ${openAiCalls[1].index}`);
check('第 2 个 function.name 正确', openAiCalls[1].function.name === 'read_file', `got ${openAiCalls[1].function.name}`);

console.log(`\n  结果：${passed} 通过，${failed} 失败\n`);

// ============================================
// 第 2 部分：buildOpenAiResponse 非流式
// ============================================

console.log('===== 第 2 部分：buildOpenAiResponse 非流式 =====\n');

// 测试 1：纯文本（无 XML）
const plainResponse = buildOpenAiResponse('fitten-code', '你好，有什么需要帮助的吗？', []);
check('纯文本响应 content 正确', plainResponse.choices[0].message.content === '你好，有什么需要帮助的吗？', `got ${plainResponse.choices[0].message.content}`);
check('纯文本响应无 tool_calls', !plainResponse.choices[0].message.tool_calls, 'unexpected tool_calls');
check('纯文本响应 finish_reason 为 stop', plainResponse.choices[0].finish_reason === 'stop', `got ${plainResponse.choices[0].finish_reason}`);

// 测试 2：纯 XML（无文本）
const xmlOnly = '<function_calls>\n<invoke tool_name="run_terminal">\n<arguments>{"command":"ls"}</arguments>\n</invoke>\n</function_calls>';
const xmlOnlyResponse = buildOpenAiResponse('fitten-code', xmlOnly, []);
check('纯 XML 响应 content 为空字符串', xmlOnlyResponse.choices[0].message.content === '', `got "${xmlOnlyResponse.choices[0].message.content}"`);
check('纯 XML 响应有 tool_calls', Array.isArray(xmlOnlyResponse.choices[0].message.tool_calls), 'no tool_calls');
check('纯 XML 响应 tool_calls 长度 1', xmlOnlyResponse.choices[0].message.tool_calls.length === 1, `got ${xmlOnlyResponse.choices[0].message.tool_calls.length}`);
check('纯 XML 响应 finish_reason 为 tool_calls', xmlOnlyResponse.choices[0].finish_reason === 'tool_calls', `got ${xmlOnlyResponse.choices[0].finish_reason}`);

// 测试 3：文本 + XML
const textAndXml = '我来帮你查一下。\n<function_calls>\n<invoke tool_name="run_terminal">\n<arguments>{"command":"ls -la"}</arguments>\n</invoke>\n</function_calls>';
const textAndXmlResponse = buildOpenAiResponse('fitten-code', textAndXml, []);
check('文本+XML 响应 content 剥离了 XML', textAndXmlResponse.choices[0].message.content === '我来帮你查一下。', `got "${textAndXmlResponse.choices[0].message.content}"`);
check('文本+XML 响应有 tool_calls', Array.isArray(textAndXmlResponse.choices[0].message.tool_calls), 'no tool_calls');
check('文本+XML 响应 tool_calls 长度 1', textAndXmlResponse.choices[0].message.tool_calls.length === 1, `got ${textAndXmlResponse.choices[0].message.tool_calls.length}`);
check('文本+XML 响应 finish_reason 为 tool_calls', textAndXmlResponse.choices[0].finish_reason === 'tool_calls', `got ${textAndXmlResponse.choices[0].finish_reason}`);

// 测试 4：多个 tool calls
const multiXml = '<function_calls>\n<invoke tool_name="run_terminal">\n<arguments>{"command":"echo first"}</arguments>\n</invoke>\n<invoke tool_name="read_file">\n<arguments>{"file_path":"test.txt"}</arguments>\n</invoke>\n</function_calls>';
const multiResponse = buildOpenAiResponse('fitten-code', multiXml, []);
check('多个 tool_calls 长度 2', multiResponse.choices[0].message.tool_calls.length === 2, `got ${multiResponse.choices[0].message.tool_calls.length}`);
check('第 1 个 name 为 run_terminal', multiResponse.choices[0].message.tool_calls[0].function.name === 'run_terminal', `got ${multiResponse.choices[0].message.tool_calls[0].function.name}`);
check('第 2 个 name 为 read_file', multiResponse.choices[0].message.tool_calls[1].function.name === 'read_file', `got ${multiResponse.choices[0].message.tool_calls[1].function.name}`);

// 测试 5：空 arguments
const emptyArgs = '<function_calls>\n<invoke tool_name="run_terminal">\n<arguments>{}</arguments>\n</invoke>\n</function_calls>';
const emptyArgsResponse = buildOpenAiResponse('fitten-code', emptyArgs, []);
check('空 arguments 转成 "{}"', emptyArgsResponse.choices[0].message.tool_calls[0].function.arguments === '{}', `got ${emptyArgsResponse.choices[0].message.tool_calls[0].function.arguments}`);

// 测试 6：复杂 arguments（嵌套对象）
const complexArgs = '<function_calls>\n<invoke tool_name="write_file">\n<arguments>{"file_path":"/tmp/test.js","content":"console.log(1)"}</arguments>\n</invoke>\n</function_calls>';
const complexArgsResponse = buildOpenAiResponse('fitten-code', complexArgs, []);
const parsedArgs = JSON.parse(complexArgsResponse.choices[0].message.tool_calls[0].function.arguments);
check('复杂 arguments 包含 file_path', parsedArgs.file_path === '/tmp/test.js', `got ${parsedArgs.file_path}`);
check('复杂 arguments 包含 content', parsedArgs.content === 'console.log(1)', `got ${parsedArgs.content}`);

console.log(`\n  结果：${passed - 9} 通过，${failed} 失败\n`);

// ============================================
// 第 3 部分：流式增量格式
// ============================================

console.log('===== 第 3 部分：流式增量格式 =====\n');

// 模拟 writeToolCallsIncremental 的输出
function simulateIncrementalToolCalls(toolCalls) {
  const chunks = [];

  for (let index = 0; index < toolCalls.length; index += 1) {
    const tc = toolCalls[index];

    // 第 1 步：id + type
    chunks.push({
      delta: {
        tool_calls: [{ index, id: tc.id, type: 'function' }]
      },
      finish_reason: null
    });

    // 第 2 步：function.name
    chunks.push({
      delta: {
        tool_calls: [{ index, function: { name: tc.function.name } }]
      },
      finish_reason: null
    });

    // 第 3 步：function.arguments（分片）
    const argsText = tc.function.arguments;
    const fragmentSize = 100;
    for (let offset = 0; offset < argsText.length; offset += fragmentSize) {
      const fragment = argsText.slice(offset, offset + fragmentSize);
      chunks.push({
        delta: {
          tool_calls: [{ index, function: { arguments: fragment } }]
        },
        finish_reason: null
      });
    }
  }

  // 最后：finish_reason = "tool_calls"
  chunks.push({
    delta: {},
    finish_reason: 'tool_calls'
  });

  return chunks;
}

const incrementalCalls = buildOpenAiToolCalls(rawToolCalls);
const chunks = simulateIncrementalToolCalls(incrementalCalls);

// 验证增量格式
check('总 chunk 数 = 2*(id+name+args) + 1(finish)', chunks.length === 7, `got ${chunks.length}`);

// 第 1 个 tool_call 的 id chunk
check('chunk[0] 包含 id', chunks[0].delta.tool_calls[0].id === 'xml_call_0', `got ${chunks[0].delta.tool_calls[0].id}`);
check('chunk[0] 包含 type', chunks[0].delta.tool_calls[0].type === 'function', `got ${chunks[0].delta.tool_calls[0].type}`);
check('chunk[0] 不包含 function', !chunks[0].delta.tool_calls[0].function, 'unexpected function');

// 第 2 个 tool_call 的 name chunk
check('chunk[1] 包含 function.name', chunks[1].delta.tool_calls[0].function.name === 'run_terminal', `got ${chunks[1].delta.tool_calls[0].function.name}`);
check('chunk[1] 不包含 id', !chunks[1].delta.tool_calls[0].id, 'unexpected id');

// 第 3 个 tool_call 的 arguments chunk
check('chunk[2] 包含 function.arguments', typeof chunks[2].delta.tool_calls[0].function.arguments === 'string', 'no arguments');

// 第 2 个 tool_call 的 id chunk
check('chunk[3] 的 index 为 1', chunks[3].delta.tool_calls[0].index === 1, `got ${chunks[3].delta.tool_calls[0].index}`);
check('chunk[3] 的 id 为 xml_call_1', chunks[3].delta.tool_calls[0].id === 'xml_call_1', `got ${chunks[3].delta.tool_calls[0].id}`);

// 最后一个 chunk
const lastChunk = chunks[chunks.length - 1];
check('最后一个 chunk finish_reason 为 tool_calls', lastChunk.finish_reason === 'tool_calls', `got ${lastChunk.finish_reason}`);
check('最后一个 chunk delta 为空对象', JSON.stringify(lastChunk.delta) === '{}', `got ${JSON.stringify(lastChunk.delta)}`);

console.log(`\n  结果：${passed - 15} 通过，${failed} 失败\n`);

// ============================================
// 第 4 部分：边界情况
// ============================================

console.log('===== 第 4 部分：边界情况 =====\n');

// 测试 1：空字符串
const emptyResponse = buildOpenAiResponse('fitten-code', '', []);
check('空字符串 content 为空', emptyResponse.choices[0].message.content === '', `got "${emptyResponse.choices[0].message.content}"`);
check('空字符串无 tool_calls', !emptyResponse.choices[0].message.tool_calls, 'unexpected tool_calls');

// 测试 2：只有空白
const whitespaceResponse = buildOpenAiResponse('fitten-code', '   \n  ', []);
check('空白 content 为空白', whitespaceResponse.choices[0].message.content === '   \n  ', `got "${whitespaceResponse.choices[0].message.content}"`);

// 测试 3：XML 标签不完整（缺少闭合标签）
const brokenXml = '<function_calls>\n<invoke tool_name="run_terminal">\n<arguments>{"command":"ls"}\n';
const brokenResponse = buildOpenAiResponse('fitten-code', brokenXml, []);
check('不完整 XML 无 tool_calls', !brokenResponse.choices[0].message.tool_calls, 'unexpected tool_calls');
check('不完整 XML content 保留原文', brokenResponse.choices[0].message.content === brokenXml, `got "${brokenResponse.choices[0].message.content}"`);

// 测试 4：XML 标签大小写
const upperXml = '<FUNCTION_CALLS>\n<INVOKE TOOL_NAME="run_terminal">\n<ARGUMENTS>{"command":"ls"}</ARGUMENTS>\n</INVOKE>\n</FUNCTION_CALLS>';
const upperResponse = buildOpenAiResponse('fitten-code', upperXml, []);
check('大写 XML 标签也能正确解析（正则带 /i）', Array.isArray(upperResponse.choices[0].message.tool_calls) && upperResponse.choices[0].message.tool_calls.length === 1, `got ${upperResponse.choices[0].message.tool_calls?.length}`);
check('大写 XML 解析出正确 tool_name', upperResponse.choices[0].message.tool_calls[0].function.name === 'run_terminal', `got ${upperResponse.choices[0].message.tool_calls[0].function.name}`);

// 测试 5：tool_name 带特殊字符
const specialName = '<function_calls>\n<invoke tool_name="my_custom_tool_123">\n<arguments>{"key":"value"}</arguments>\n</invoke>\n</function_calls>';
const specialResponse = buildOpenAiResponse('fitten-code', specialName, []);
check('特殊 tool_name 正确解析', specialResponse.choices[0].message.tool_calls[0].function.name === 'my_custom_tool_123', `got ${specialResponse.choices[0].message.tool_calls[0].function.name}`);

// 测试 6：arguments 含特殊字符
const specialArgs = '<function_calls>\n<invoke tool_name="run_terminal">\n<arguments>{"command":"echo \\"hello world\\""}</arguments>\n</invoke>\n</function_calls>';
const specialArgsResponse = buildOpenAiResponse('fitten-code', specialArgs, []);
const parsedSpecialArgs = JSON.parse(specialArgsResponse.choices[0].message.tool_calls[0].function.arguments);
check('arguments 含转义引号正确解析', parsedSpecialArgs.command === 'echo "hello world"', `got ${parsedSpecialArgs.command}`);

// 测试 7：自闭合工具标签
const selfClosingXml = '<function_calls>\n<execute_command command="git status" cwd="." timeout="null" />\n</function_calls>';
const selfClosingResponse = buildOpenAiResponse('fitten-code', selfClosingXml, []);
check('自闭合工具标签能解析出 tool_calls', Array.isArray(selfClosingResponse.choices[0].message.tool_calls) && selfClosingResponse.choices[0].message.tool_calls.length === 1, `got ${selfClosingResponse.choices[0].message.tool_calls?.length}`);
check('自闭合工具标签解析出正确函数名', selfClosingResponse.choices[0].message.tool_calls[0].function.name === 'execute_command', `got ${selfClosingResponse.choices[0].message.tool_calls[0].function.name}`);
const parsedSelfClosingArgs = JSON.parse(selfClosingResponse.choices[0].message.tool_calls[0].function.arguments);
check('自闭合工具标签解析出 command 属性', parsedSelfClosingArgs.command === 'git status', `got ${parsedSelfClosingArgs.command}`);
check('自闭合工具标签解析出 cwd 属性', parsedSelfClosingArgs.cwd === '.', `got ${parsedSelfClosingArgs.cwd}`);
check('字符串 null 会被转成真正的 null', parsedSelfClosingArgs.timeout === null, `got ${parsedSelfClosingArgs.timeout}`);

// 测试 8：属性值类型归一化
const typedAttrsXml = '<function_calls>\n<execute_command timeout="10" dry_run="true" retries="0" />\n</function_calls>';
const typedAttrsResponse = buildOpenAiResponse('fitten-code', typedAttrsXml, []);
const parsedTypedAttrs = JSON.parse(typedAttrsResponse.choices[0].message.tool_calls[0].function.arguments);
check('数字字符串会被转成 number', parsedTypedAttrs.timeout === 10, `got ${parsedTypedAttrs.timeout}`);
check('true 字符串会被转成 boolean true', parsedTypedAttrs.dry_run === true, `got ${parsedTypedAttrs.dry_run}`);
check('0 字符串会被转成 number 0', parsedTypedAttrs.retries === 0, `got ${parsedTypedAttrs.retries}`);

// 测试 9：无引号属性值
const unquotedAttrsXml = '<function_calls>\n<execute_command command="git status" cwd="." timeout=null />\n</function_calls>';
const unquotedAttrsResponse = buildOpenAiResponse('fitten-code', unquotedAttrsXml, []);
const parsedUnquotedAttrs = JSON.parse(unquotedAttrsResponse.choices[0].message.tool_calls[0].function.arguments);
check('无引号 null 属性值也能解析', parsedUnquotedAttrs.timeout === null, `got ${parsedUnquotedAttrs.timeout}`);

// 测试 10：嵌套子标签格式
const nestedTagXml = '<function_calls>\n<execute_command>\n  <command>git add .</command>\n  <cwd>.</cwd>\n  <timeout>30</timeout>\n</execute_command>\n</function_calls>';
const nestedTagResponse = buildOpenAiResponse('fitten-code', nestedTagXml, []);
check('嵌套子标签格式能解析出 tool_calls', Array.isArray(nestedTagResponse.choices[0].message.tool_calls) && nestedTagResponse.choices[0].message.tool_calls.length === 1, `got ${nestedTagResponse.choices[0].message.tool_calls?.length}`);
check('嵌套子标签格式解析出正确函数名', nestedTagResponse.choices[0].message.tool_calls[0].function.name === 'execute_command', `got ${nestedTagResponse.choices[0].message.tool_calls[0].function.name}`);
const parsedNestedTagArgs = JSON.parse(nestedTagResponse.choices[0].message.tool_calls[0].function.arguments);
check('嵌套子标签格式解析出 command', parsedNestedTagArgs.command === 'git add .', `got ${parsedNestedTagArgs.command}`);
check('嵌套子标签格式解析出 cwd', parsedNestedTagArgs.cwd === '.', `got ${parsedNestedTagArgs.cwd}`);
check('嵌套子标签格式解析出数字 timeout', parsedNestedTagArgs.timeout === 30, `got ${parsedNestedTagArgs.timeout}`);

// 测试 11：function_call 包装格式 + XML arguments
const wrapperXml = '<function_calls>\n<function_call>\n  <name>execute_command</name>\n  <arguments>\n    <command>git add .</command>\n    <cwd>.</cwd>\n    <timeout>5</timeout>\n  </arguments>\n</function_call>\n</function_calls>';
const wrapperResponse = buildOpenAiResponse('fitten-code', wrapperXml, []);
check('function_call 包装格式能解析出 tool_calls', Array.isArray(wrapperResponse.choices[0].message.tool_calls) && wrapperResponse.choices[0].message.tool_calls.length === 1, `got ${wrapperResponse.choices[0].message.tool_calls?.length}`);
check('function_call 包装格式解析出正确函数名', wrapperResponse.choices[0].message.tool_calls[0].function.name === 'execute_command', `got ${wrapperResponse.choices[0].message.tool_calls[0].function.name}`);
const parsedWrapperArgs = JSON.parse(wrapperResponse.choices[0].message.tool_calls[0].function.arguments);
check('function_call 包装格式解析出 command', parsedWrapperArgs.command === 'git add .', `got ${parsedWrapperArgs.command}`);
check('function_call 包装格式解析出 cwd', parsedWrapperArgs.cwd === '.', `got ${parsedWrapperArgs.cwd}`);
check('function_call 包装格式解析出 timeout', parsedWrapperArgs.timeout === 5, `got ${parsedWrapperArgs.timeout}`);

// 测试 12：JSON 工具调用（模型有时会输出 JSON 而不是 XML）
const jsonToolCall = '{\n  "command": "git status",\n  "cwd": null,\n  "timeout": null\n}';
const jsonResponse = buildOpenAiResponse('fitten-code', jsonToolCall, []);
check('JSON 工具调用能解析出 tool_calls', Array.isArray(jsonResponse.choices[0].message.tool_calls) && jsonResponse.choices[0].message.tool_calls.length === 1, `got ${jsonResponse.choices[0].message.tool_calls?.length}`);
check('JSON 工具调用推断出 execute_command', jsonResponse.choices[0].message.tool_calls[0].function.name === 'execute_command', `got ${jsonResponse.choices[0].message.tool_calls[0].function.name}`);
const parsedJsonArgs = JSON.parse(jsonResponse.choices[0].message.tool_calls[0].function.arguments);
check('JSON 工具调用解析出 command', parsedJsonArgs.command === 'git status', `got ${parsedJsonArgs.command}`);
check('JSON 工具调用保留 null 值', parsedJsonArgs.cwd === null, `got ${parsedJsonArgs.cwd}`);

// 测试 13：JSON 工具调用（带 name 字段）
const jsonWithName = '{\n  "name": "execute_command",\n  "command": "ls -la",\n  "cwd": "."\n}';
const jsonNameResponse = buildOpenAiResponse('fitten-code', jsonWithName, []);
check('JSON 带 name 字段能解析出 tool_calls', Array.isArray(jsonNameResponse.choices[0].message.tool_calls) && jsonNameResponse.choices[0].message.tool_calls.length === 1, `got ${jsonNameResponse.choices[0].message.tool_calls?.length}`);
check('JSON 带 name 字段解析出正确函数名', jsonNameResponse.choices[0].message.tool_calls[0].function.name === 'execute_command', `got ${jsonNameResponse.choices[0].message.tool_calls[0].function.name}`);

// 测试 14：纯文本不应被误判为 JSON 工具调用
const plainTextResponse = buildOpenAiResponse('fitten-code', '你好，有什么需要帮助的吗？', []);
check('纯文本不应被误判为 JSON 工具调用', !plainTextResponse.choices[0].message.tool_calls, 'unexpected tool_calls');

// 测试 15：方括号 function_calls 包装协议
const bracketFunctionCalls = '[function_calls]\n<ask_followup_question question="请提供你希望的commit信息。" follow_up="[{ "text": "更新README.md和index.js文件，修复了一些问题" }]" />\n[/function_calls]';
const bracketFunctionResponse = buildOpenAiResponse('fitten-code', bracketFunctionCalls, []);
check('方括号 function_calls 能解析出 tool_calls', Array.isArray(bracketFunctionResponse.choices[0].message.tool_calls) && bracketFunctionResponse.choices[0].message.tool_calls.length === 1, `got ${bracketFunctionResponse.choices[0].message.tool_calls?.length}`);
check('方括号 function_calls 解析出正确函数名', bracketFunctionResponse.choices[0].message.tool_calls[0].function.name === 'ask_followup_question', `got ${bracketFunctionResponse.choices[0].message.tool_calls[0].function.name}`);
const parsedBracketFunctionArgs = JSON.parse(bracketFunctionResponse.choices[0].message.tool_calls[0].function.arguments);
check('方括号 function_calls 解析出 question', parsedBracketFunctionArgs.question === '请提供你希望的commit信息。', `got ${parsedBracketFunctionArgs.question}`);
check('方括号 function_calls 解码 " 实体', parsedBracketFunctionArgs.follow_up.includes('"text"'), `got ${parsedBracketFunctionArgs.follow_up}`);

// 测试 16：方括号 tool_calls 包装协议
const bracketToolCalls = '[tool_calls]\n<execute_command command="git status" cwd="." />\n[/tool_calls]';
const bracketToolResponse = buildOpenAiResponse('fitten-code', bracketToolCalls, []);
check('方括号 tool_calls 能解析出 tool_calls', Array.isArray(bracketToolResponse.choices[0].message.tool_calls) && bracketToolResponse.choices[0].message.tool_calls.length === 1, `got ${bracketToolResponse.choices[0].message.tool_calls?.length}`);
check('方括号 tool_calls 解析出 execute_command', bracketToolResponse.choices[0].message.tool_calls[0].function.name === 'execute_command', `got ${bracketToolResponse.choices[0].message.tool_calls[0].function.name}`);
const parsedBracketToolArgs = JSON.parse(bracketToolResponse.choices[0].message.tool_calls[0].function.arguments);
check('方括号 tool_calls 解析出 command', parsedBracketToolArgs.command === 'git status', `got ${parsedBracketToolArgs.command}`);
check('方括号 tool_calls 解析出 cwd', parsedBracketToolArgs.cwd === '.', `got ${parsedBracketToolArgs.cwd}`);

console.log(`\n  结果：${passed - 54} 通过，${failed} 失败\n`);

// ============================================
// 汇总
// ============================================

console.log('========================================');
console.log('  汇总');
console.log('========================================\n');
console.log(`  ${passed} 通过，${failed} 失败\n`);

process.exit(failed > 0 ? 1 : 0);
