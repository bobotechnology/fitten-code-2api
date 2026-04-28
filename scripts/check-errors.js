const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');

function runServer(envOverrides, port, requestBody) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(projectRoot, 'index.js')], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PORT: String(port),
        ...envOverrides
      }
    });

    let stderr = '';
    let finished = false;

    function done(result) {
      if (finished) return;
      finished = true;
      if (child.exitCode === null && !child.killed) child.kill();
      setTimeout(() => resolve(result), 50);
    }

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('exit', (code) => {
      if (!finished && code !== null) {
        done({ error: `child exited ${code}`, stderr });
      }
    });

    child.stdout.once('data', () => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
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
            done({ status: res.statusCode, body: data, stderr });
          });
        }
      );

      req.on('error', (error) => done({ error: error.message, stderr }));
      req.write(JSON.stringify(requestBody));
      req.end();
    });

    setTimeout(() => done({ error: 'timeout', stderr }), 30000);
  });
}

(async () => {
  const badCredential = await runServer(
    {
      FITTEN_USERNAME: process.env.FITTEN_USERNAME,
      FITTEN_PASSWORD: 'invalid-password-for-test',
      FITTEN_REQUEST_TIMEOUT_MS: '120000'
    },
    3019,
    {
      model: 'fitten-code',
      messages: [{ role: 'user', content: '你好' }]
    }
  );

  const timeoutCase = await runServer(
    {
      FITTEN_USERNAME: process.env.FITTEN_USERNAME,
      FITTEN_PASSWORD: process.env.FITTEN_PASSWORD,
      FITTEN_REQUEST_TIMEOUT_MS: '5'
    },
    3020,
    {
      model: 'fitten-code',
      messages: [{ role: 'user', content: '你好' }]
    }
  );

  console.log(JSON.stringify({ bad_credential: badCredential, timeout_case: timeoutCase }, null, 2));
  process.exit(0);
})().catch((error) => {
  console.log(JSON.stringify({ error: error.message, stack: error.stack }, null, 2));
  process.exit(1);
});
