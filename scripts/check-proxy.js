const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const child = spawn(process.execPath, [path.join(projectRoot, 'index.js')], {
  cwd: projectRoot,
  env: {
    ...process.env,
    PORT: '3013',
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

child.stdout.on('data', () => {
  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: 3013,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    },
    (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        finish(0, { status: res.statusCode, body: data.slice(0, 2500) });
      });
    }
  );

  req.on('error', (error) => finish(1, { error: error.message, stderr }));
  req.write(
    JSON.stringify({
      model: 'fitten-code',
      messages: [{ role: 'user', content: '你好，请只回复 ok' }],
      stream: false
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
