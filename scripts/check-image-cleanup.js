const { spawn } = require('child_process');
const http = require('http');

const path = require('path');
const projectRoot = path.resolve(__dirname, '..');
const redPixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8AABYMBgQZ8xXQAAAAASUVORK5CYII=';

const child = spawn(process.execPath, [path.join(projectRoot, 'index.js')], {
  cwd: projectRoot,
  env: {
    ...process.env,
    PORT: '3026',
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

function request(body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 3026,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
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
    const response = await request({
      model: 'fitten-code',
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_image', image_url: redPixel },
            { type: 'input_text', text: '请描述这张图片，只回复一句话。' }
          ]
        }
      ]
    });

    const parsed = JSON.parse(response.body);
    const content = parsed?.choices?.[0]?.message?.content || '';

    finish(0, {
      status: response.status,
      content,
      starts_with_nul: /^\u0000+/.test(content),
      visible_content_preview: content.slice(0, 100)
    });
  } catch (error) {
    finish(1, { error: error.message, stderr, stack: error.stack });
  }
});

setTimeout(() => finish(1, { error: 'timeout', stderr }), 30000);
