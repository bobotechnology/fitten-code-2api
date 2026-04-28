const { spawn } = require('child_process');
const http = require('http');

const path = require('path');
const projectRoot = path.resolve(__dirname, '..');
const redPixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8AABYMBgQZ8xXQAAAAASUVORK5CYII=';

const child = spawn(process.execPath, [path.join(projectRoot, 'index.js')], {
  cwd: projectRoot,
  env: {
    ...process.env,
    PORT: '3025',
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
        port: 3025,
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

function parseSseEvents(raw) {
  return raw
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => block.replace(/^data:\s*/gm, '').trim())
    .filter(Boolean);
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
      stream: true,
      stream_options: { include_usage: true },
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

    const events = parseSseEvents(response.body);
    const parsedEvents = events
      .filter((event) => event !== '[DONE]')
      .map((event) => {
        try {
          return JSON.parse(event);
        } catch (error) {
          return { parse_error: true, raw: event };
        }
      });

    const content = parsedEvents
      .flatMap((event) => Array.isArray(event.choices) ? event.choices : [])
      .map((choice) => choice?.delta?.content || '')
      .join('');

    finish(0, {
      status: response.status,
      event_count: events.length,
      has_done: events.includes('[DONE]'),
      has_usage_chunk: parsedEvents.some((event) => Array.isArray(event.choices) && event.choices.length === 0 && event.usage),
      content,
      raw_preview: response.body.slice(0, 1500)
    });
  } catch (error) {
    finish(1, { error: error.message, stderr, stack: error.stack });
  }
});

setTimeout(() => finish(1, { error: 'timeout', stderr }), 45000);
