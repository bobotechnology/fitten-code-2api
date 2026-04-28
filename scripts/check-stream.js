const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const child = spawn(process.execPath, [path.join(projectRoot, 'index.js')], {
  cwd: projectRoot,
  env: {
    ...process.env,
    PORT: '3015',
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

function parseContentFromEvent(eventText) {
  if (!eventText.startsWith('data: ')) return null;
  const payload = eventText.slice(6);
  if (payload === '[DONE]') return { type: 'done', value: '[DONE]' };


  try {
    const data = JSON.parse(payload);
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    if (!choice || !choice.delta) return null;
    if (typeof choice.delta.role === 'string') return { type: 'role', value: choice.delta.role };
    if (typeof choice.delta.content === 'string') return { type: 'content', value: choice.delta.content };
    if (choice.finish_reason) return { type: 'finish', value: choice.finish_reason };
    return null;
  } catch (error) {
    return { type: 'raw', value: payload };
  }
}

child.stdout.once('data', () => {
  const startedAt = Date.now();
  const chunks = [];
  const events = [];
  const contentEvents = [];
  let raw = '';
  let buffer = '';

  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: 3015,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    },
    (res) => {
      res.on('data', (chunk) => {
        const text = chunk.toString();
        const atMs = Date.now() - startedAt;
        raw += text;
        buffer += text;
        chunks.push({
          at_ms: atMs,
          bytes: chunk.length,
          preview: text.slice(0, 200)
        });

        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const trimmed = part.trim();
          if (!trimmed) continue;
          events.push({
            at_ms: atMs,
            event: trimmed
          });
          const parsed = parseContentFromEvent(trimmed);
          if (parsed) {
            contentEvents.push({
              at_ms: atMs,
              ...parsed
            });
          }
        }
      });

      res.on('end', () => {
        const trailing = buffer.trim();
        if (trailing) {
          const atMs = Date.now() - startedAt;
          events.push({ at_ms: atMs, event: trailing });
          const parsed = parseContentFromEvent(trailing);
          if (parsed) {
            contentEvents.push({ at_ms: atMs, ...parsed });
          }
        }

        const contentOnly = contentEvents.filter((item) => item.type === 'content');
        const finishEvents = contentEvents.filter((item) => item.type === 'finish');
        const doneEvents = contentEvents.filter((item) => item.type === 'done');


        finish(0, {
          status: res.statusCode,
          headers: res.headers,
          chunk_count: chunks.length,
          event_count: events.length,
          content_event_count: contentOnly.length,
          newline_only_content_events: contentOnly.filter((item) => /^\n+$/.test(item.value)).length,
          aggregated_content_preview: contentOnly.map((item) => item.value).join('').slice(0, 500),
          first_chunk_at_ms: chunks[0]?.at_ms ?? null,
          first_event_at_ms: events[0]?.at_ms ?? null,
          last_event_at_ms: events[events.length - 1]?.at_ms ?? null,
          chunk_gaps_ms: chunks.slice(1).map((item, index) => item.at_ms - chunks[index].at_ms),
          event_gaps_ms: events.slice(1).map((item, index) => item.at_ms - events[index].at_ms),
          finish_event_count: finishEvents.length,
          done_event_count: doneEvents.length,
          chunks,
          content_events: contentEvents,
          raw_preview: raw.slice(0, 4000)
        });
      });
    }
  );

  req.on('error', (error) => finish(1, { error: error.message, stderr }));
  req.write(
    JSON.stringify({
      model: 'fitten-code',
      messages: [
        {
          role: 'user',
          content: '请按 1、2、3、4、5 的顺序逐个输出，每个数字单独成段，不要解释。'
        }
      ],
      stream: true,
      stream_options: { include_usage: true }
    })
  );
  req.end();
});

child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

child.on('exit', (code) => {
  if (!finished && code !== null) {
    finish(1, { error: `child exited ${code}`, stderr });
  }
});

setTimeout(() => finish(1, { error: 'timeout', stderr }), 20000);



