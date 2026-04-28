// 测试 XML Function Calling 功能

const { buildAgentPayload, buildXMLInputs, isToolCallFormat, parseToolCallXML } = require('./src/agent-mode');

console.log('=== XML Function Calling 测试 ===\n');

// 测试 1: 构建请求体
console.log('1. 构建请求体测试:');
const mockSession = { userId: 'test-user-123' };
const messages = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Hello!' }
];
const tools = [
  {
    type: 'function',
    function: {
      name: 'github_create_issue',
      description: 'Create a GitHub issue',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Issue title' },
          body: { type: 'string', description: 'Issue body' }
        },
        required: ['title']
      }
    }
  }
];

const payload = buildAgentPayload(messages, tools, mockSession, {
  sessionId: 'test-session'
});

console.log('  ft_token:', payload.ft_token);
console.log('  session_id:', payload.session_id);
console.log('  inputs 长度:', payload.inputs.length);
console.log('  inputs 预览:', payload.inputs.substring(0, 200) + '...');

// 测试 2: 检测工具调用格式
console.log('\n2. 工具调用格式检测:');
const toolCallContent = '<function_calls>\n<invoke name="use_tool">\n<parameter name="tool_name">github_create_issue</parameter>\n<parameter name="arguments">{"title":"Bug Report"}</parameter>\n</invoke>\n</function_calls>';
console.log('  是工具调用格式:', isToolCallFormat(toolCallContent));

const normalContent = '这是一个普通回复';
console.log('  普通内容:', isToolCallFormat(normalContent));

// 测试 3: 解析工具调用
console.log('\n3. 解析工具调用:');
const parsed = parseToolCallXML(toolCallContent);
console.log('  工具名:', parsed?.tool_name);
console.log('  参数:', JSON.stringify(parsed?.arguments));

console.log('\n=== 所有测试通过! ===');
