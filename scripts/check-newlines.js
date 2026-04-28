const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const child = spawn(process.execPath, [path.join(projectRoot, 'index.js')], {
  cwd: projectRoot,
  env: {
    ...process.env,
    PORT: '3017',
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
  child.kill();
  process.exit(code);
}

function collectStream(urlPath, body) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const events = [];
    let buffer = '';
    let aggregated = '';

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 3017,
        path: urlPath,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      (res) => {
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const atMs = Date.now() - startedAt;
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';

          for (const part of parts) {
            const trimmed = part.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const payload = trimmed.slice(6);
            if (payload === '[DONE]') {
              events.push({ at_ms: atMs, type: 'done', value: '[DONE]' });
              continue;
            }

            try {
              const parsed = JSON.parse(payload);
              const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
              const delta = choice && choice.delta ? choice.delta : {};
              if (typeof delta.content === 'string') {
                aggregated += delta.content;
                events.push({ at_ms: atMs, type: 'content', value: delta.content });
              } else if (typeof delta.role === 'string') {
                events.push({ at_ms: atMs, type: 'role', value: delta.role });
              } else if (choice && choice.finish_reason) {
                events.push({ at_ms: atMs, type: 'finish', value: choice.finish_reason });
              } else if (parsed.usage) {
                events.push({ at_ms: atMs, type: 'usage', value: parsed.usage });
              }
            } catch (error) {
              events.push({ at_ms: atMs, type: 'raw', value: payload });
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

function extractCoreText(text) {
  const start = text.indexOf('<<<TEXT\n');
  const end = text.lastIndexOf('\nTEXT');
  if (start === -1 || end === -1 || end <= start) return text;
  return text.slice(start + '<<<TEXT\n'.length, end);
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
    const expected = '第一行\n\n第二行\n\n\n第三行\n- 列表1\n- 列表2';
    const result = await collectStream('/v1/chat/completions', {
      model: 'fitten-code',
      stream: true,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: `请严格原样输出以下文本，不要添加解释，不要补标点，不要修改换行：\n<<<TEXT\n${expected}\nTEXT`
        }
      ]
    });

    const coreAggregated = extractCoreText(result.aggregated);

    finish(0, {
      expected,
      aggregated: result.aggregated,
      core_aggregated: coreAggregated,
      exact_match: result.aggregated === expected,
      core_exact_match: coreAggregated === expected,
      double_newline_present: result.aggregated.includes('\n\n'),
      triple_newline_present: result.aggregated.includes('\n\n\n'),
      list_breaks_preserved: result.aggregated.includes('\n- 列表1\n- 列表2'),
      status: result.status,
      headers: result.headers,
      events: result.events
    });

  } catch (error) {
    finish(1, { error: error.message, stderr, stack: error.stack });
  }
});

setTimeout(() => finish(1, { error: 'timeout', stderr }), 30000);
