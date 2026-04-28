const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'fitten-code';

const { cleanMessages, ensureDefaultSystemMessage } = require('./message-content');
const { getNonEmptyString } = require('./helpers');

async function buildOpenAiRequest(body) {
  if (!body || typeof body !== 'object') return null;

  const model = getModel(body);
  const messages = await getMessages(body);
  const stream = getStream(body);
  const streamOptions = getStreamOptions(body);
  const tools = getTools(body);
  const toolChoice = getToolChoice(body);

  if (!model || !messages.length) return null;

  const result = { model, messages };

  if (typeof stream === 'boolean') result.stream = stream;
  if (streamOptions) result.stream_options = streamOptions;
  if (tools) result.tools = tools;
  if (toolChoice !== undefined) result.tool_choice = toolChoice;

  return result;
}

function getFittenCredentials() {
  return {
    username: getNonEmptyString(process.env.FITTEN_USERNAME),
    password: getNonEmptyString(process.env.FITTEN_PASSWORD)
  };
}

function getModel(body) {
  if (typeof body.model === 'string' && body.model.trim()) return body.model.trim();
  if (typeof body.modelName === 'string' && body.modelName.trim()) return body.modelName.trim();
  if (typeof body.name === 'string' && body.name.trim()) return body.name.trim();
  return DEFAULT_MODEL;
}

async function getMessages(body) {
  let messages = [];
  if (Array.isArray(body.messages)) messages = await cleanMessages(body.messages);
  else if (Array.isArray(body.prompt)) messages = await cleanMessages(body.prompt);
  else if (typeof body.prompt === 'string' && body.prompt.trim()) messages = [{ role: 'user', content: body.prompt.trim() }];
  else if (typeof body.input === 'string' && body.input.trim()) messages = [{ role: 'user', content: body.input.trim() }];

  if (!messages.length) return [];
  return ensureDefaultSystemMessage(messages);
}

function getStream(body) {
  if (typeof body.stream === 'boolean') return body.stream;
  return undefined;
}

function getStreamOptions(body) {
  if (!body || typeof body.stream_options !== 'object' || body.stream_options === null) return undefined;

  const result = {};
  if (typeof body.stream_options.include_usage === 'boolean') {
    result.include_usage = body.stream_options.include_usage;
  }

  return Object.keys(result).length ? result : undefined;
}

function getTools(body) {
  if (!Array.isArray(body?.tools) || !body.tools.length) return undefined;

  // 只保留 function 类型工具
  const validTools = body.tools.filter(
    (tool) => tool && tool.type === 'function' && tool.function && typeof tool.function.name === 'string'
  );

  return validTools.length ? validTools : undefined;
}

function getToolChoice(body) {
  if (body?.tool_choice === undefined || body?.tool_choice === null) return undefined;

  // "auto" | "none" | "required" | { type: "function", function: { name: "..." } }
  if (typeof body.tool_choice === 'string') return body.tool_choice;
  if (typeof body.tool_choice === 'object' && body.tool_choice.type) return body.tool_choice;

  return undefined;
}

module.exports = {
  buildOpenAiRequest,
  getFittenCredentials,
  DEFAULT_MODEL
};
