const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const child = spawn(process.execPath, [path.join(projectRoot, 'index.js')], {
  cwd: projectRoot,
  env: {
    ...process.env,
    PORT: '3018',
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
  if (child.exitCode === null && !child.killed) child.kill();
  setTimeout(() => process.exit(code), 50);
}

function collectStream(body) {
  return new Promise((resolve, reject) => {
    const events = [];
    let buffer = '';
    let aggregated = '';

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 3018,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      (res) => {
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';

          for (const part of parts) {
            const trimmed = part.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const payload = trimmed.slice(6);
            if (payload === '[DONE]') {
              events.push({ type: 'done', value: '[DONE]' });
              continue;
            }

            const parsed = JSON.parse(payload);
            const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
            const delta = choice && choice.delta ? choice.delta : {};
            if (typeof delta.content === 'string') {
              aggregated += delta.content;
              events.push({ type: 'content', value: delta.content });
            } else if (typeof delta.role === 'string') {
              events.push({ type: 'role', value: delta.role });
            } else if (choice && choice.finish_reason) {
              events.push({ type: 'finish', value: choice.finish_reason });
            }
          }
        });

        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            aggregated,
            events
          });
        });
      }
    );

    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

child.on('exit', (code) => {
  if (!finished && code !== null) finish(1, { error: `child exited ${code}`, stderr });
});

child.stdout.once('data', async () => {
  try {
    const expected = ['段落一', '', '```js', 'const x = 1;', 'console.log(x);', '```', '', '- 列表A', '- 列表B', '', '> 引用'];
    const expectedText = expected.join('\n');
    const response = await collectStream({
      model: 'fitten-code',
      stream: true,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: `请严格原样输出以下 Markdown 内容，不要添加解释，不要修改缩进和换行：\n<<<MD\n${expectedText}\nMD`
        }
      ]
    });

    const aggregated = response.aggregated;
    const start = aggregated.indexOf('<<<MD\n');
    const end = aggregated.lastIndexOf('\nMD');
    const core = start >= 0 && end > start ? aggregated.slice(start + '<<<MD\n'.length, end) : aggregated;

    finish(0, {
      expected: expectedText,
      aggregated,
      core,
      core_exact_match: core === expectedText,
      code_fence_preserved: core.includes('```js\nconst x = 1;\nconsole.log(x);\n```'),
      list_preserved: core.includes('- 列表A\n- 列表B'),
      quote_preserved: core.includes('> 引用'),
      events: response.events,
      status: response.status,
      headers: response.headers
    });
  } catch (error) {
    finish(1, { error: error.message, stderr, stack: error.stack });
  }
});

setTimeout(() => finish(1, { error: 'timeout', stderr }), 30000);
