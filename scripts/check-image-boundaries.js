const { spawn } = require('child_process');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const checks = [
  'check-multi-image-rejected.js',
  'check-image-size-limit.js',
  'check-remote-image-size-limit.js',
  'check-invalid-image-data-url.js',
  'check-remote-image-not-image.js',
  'check-remote-image-empty.js',
  'check-unsupported-image-url.js'
];

function runCheck(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, file)], {
      cwd: projectRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('exit', (code) => {
      let parsed = null;
      try {
        parsed = stdout.trim() ? JSON.parse(stdout) : null;
      } catch (error) {
        parsed = null;
      }

      const passed = code === 0 && parsed && parsed.rejected_as_expected === true;
      resolve({
        file,
        passed,
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        parsed
      });
    });
  });
}

(async () => {
  const results = [];
  for (const file of checks) {
    results.push(await runCheck(file));
  }

  const passed = results.filter((item) => item.passed).length;
  const failed = results.length - passed;

  console.log(JSON.stringify({
    summary: {
      total: results.length,
      passed,
      failed
    },
    results: results.map((item) => ({
      file: item.file,
      passed: item.passed,
      exitCode: item.exitCode,
      status: item.parsed?.status ?? null,
      error_code: item.parsed?.error_code ?? null,
      error_param: item.parsed?.error_param ?? null,
      rejected_as_expected: item.parsed?.rejected_as_expected ?? false,
      stderr: item.stderr || ''
    }))
  }, null, 2));

  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.log(JSON.stringify({ error: error.message, stack: error.stack }, null, 2));
  process.exit(1);
});
