const { spawn } = require('child_process');
const OpenAI = require('openai');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const child = spawn(process.execPath, [path.join(projectRoot, 'index.js')], {
  cwd: projectRoot,
  env: {
    ...process.env,
    PORT: '3016',
    FITTEN_USERNAME: process.env.FITTEN_USERNAME,
    FITTEN_PASSWORD: process.env.FITTEN_PASSWORD
  }
});

let stderr = '';
let finished = false;

function finish(code, payload) {
  if (finished) return;
  finished = true;
  console.log(typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
  if (child.exitCode === null && !child.killed) {
    child.kill();
  }
  setTimeout(() => process.exit(code), 50);
}


child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

child.on('exit', (code) => {
  if (!finished && code !== null) {
    finish(1, { error: `child exited ${code}`, stderr });
  }
});

child.stdout.once('data', async () => {
  try {
    const client = new OpenAI({
      apiKey: 'dummy',
      baseURL: 'http://127.0.0.1:3016/v1'
    });

    const startedAt = Date.now();
    const stream = await client.chat.completions.create({
      model: 'fitten-code',
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        {
          role: 'user',
          content: '请按 1、2、3、4、5 的顺序逐个输出，每个数字单独成段，不要解释。'
        }
      ]
    });

    const chunks = [];
    let aggregated = '';
    let usage = null;

    for await (const chunk of stream) {
      const atMs = Date.now() - startedAt;
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
      const delta = choice && choice.delta ? choice.delta : {};
      const content = typeof delta.content === 'string' ? delta.content : '';
      if (content) aggregated += content;
      if (chunk.usage) usage = chunk.usage;

      chunks.push({
        at_ms: atMs,
        role: delta.role || null,
        content: content || null,
        finish_reason: choice ? choice.finish_reason : null,
        has_usage: !!chunk.usage
      });
    }

    finish(0, {
      chunk_count: chunks.length,
      first_chunk_at_ms: chunks[0]?.at_ms ?? null,
      last_chunk_at_ms: chunks[chunks.length - 1]?.at_ms ?? null,
      aggregated,
      usage,
      chunks
    });
  } catch (error) {
    finish(1, { error: error.message, stderr, stack: error.stack });
  }
});

setTimeout(() => finish(1, { error: 'timeout', stderr }), 30000);
