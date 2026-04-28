/**
 * 并发压测脚本
 *
 * 自动启动代理服务，逐步递增并发数，测量每轮的响应时间、成功率和吞吐量。
 *
 * 用法：
 *   FITTEN_USERNAME=xxx FITTEN_PASSWORD=xxx node scripts/check-concurrency.js
 *
 * 环境变量：
 *   FITTEN_USERNAME        Fitten 登录账号（必填）
 *   FITTEN_PASSWORD        Fitten 登录密码（必填）
 *   CONCURRENCY_PORT       代理监听端口，默认 3090
 *   CONCURRENCY_LEVELS     并发级别列表，默认 1,2,4,8
 *   CONCURRENCY_ROUNDS     每个级别跑几轮，默认 2
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const PORT = Number(process.env.CONCURRENCY_PORT || 3090);
const LEVELS = (process.env.CONCURRENCY_LEVELS || '1,2,4,8').split(',').map(Number);
const ROUNDS = Number(process.env.CONCURRENCY_ROUNDS || 2);

if (!process.env.FITTEN_USERNAME || !process.env.FITTEN_PASSWORD) {
  console.error('请设置 FITTEN_USERNAME 和 FITTEN_PASSWORD 环境变量');
  process.exit(1);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectRoot, 'index.js')], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PORT: String(PORT)
      }
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('exit', (code) => {
      if (code !== null) reject(new Error(`server exited: ${code}; stderr=${stderr.slice(0, 500)}`));
    });

    child.stdout.once('data', () => resolve(child));
    setTimeout(() => reject(new Error(`server start timeout; stderr=${stderr.slice(0, 500)}`)), 10000);
  });
}

function sendRequest() {
  return new Promise((resolve) => {
    const start = Date.now();
    const body = JSON.stringify({
      model: 'fitten-code',
      messages: [{ role: 'user', content: '请只回复 ok' }],
      stream: false
    });

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          const elapsed = Date.now() - start;
          let success = false;
          let content = '';
          try {
            const parsed = JSON.parse(data);
            content = parsed?.choices?.[0]?.message?.content || '';
            success = res.statusCode === 200 && content.length > 0;
          } catch (_) { /* ignore */ }
          resolve({ elapsed, status: res.statusCode, success, contentPreview: content.slice(0, 40) });
        });
      }
    );

    req.on('error', (error) => {
      resolve({ elapsed: Date.now() - start, status: 0, success: false, error: error.code || error.message });
    });

    req.setTimeout(120000, () => {
      req.destroy(new Error('timeout'));
    });

    req.write(body);
    req.end();
  });
}

async function runLevel(concurrency) {
  const allResults = [];

  for (let round = 0; round < ROUNDS; round++) {
    const tasks = [];
    for (let i = 0; i < concurrency; i++) {
      tasks.push(sendRequest());
    }

    const roundStart = Date.now();
    const results = await Promise.all(tasks);
    const wallTime = Date.now() - roundStart;

    const successes = results.filter((r) => r.success).length;
    const failures = results.length - successes;
    const times = results.map((r) => r.elapsed);
    const avgTime = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    const maxTime = Math.max(...times);
    const minTime = Math.min(...times);
    const sorted = [...times].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const rps = times.length > 0 ? (successes / (wallTime / 1000)).toFixed(2) : '0';

    allResults.push({
      round: round + 1,
      concurrency,
      total: results.length,
      successes,
      failures,
      wallTime,
      avgTime,
      minTime,
      maxTime,
      p50,
      p95,
      rps
    });
  }

  return allResults;
}

async function main() {
  console.log('fitten-code-2api 并发压测');
  console.log(`端口: ${PORT}`);
  console.log(`并发级别: ${LEVELS.join(', ')}`);
  console.log(`每级别轮次: ${ROUNDS}`);
  console.log('正在启动服务...');

  const server = await startServer();
  console.log('服务已启动\n---');

  const allRows = [];

  try {
    for (const level of LEVELS) {
      console.log(`\n▶ 并发 ${level} ...`);
      const results = await runLevel(level);
      allRows.push(...results);

      for (const r of results) {
        console.log(
          `  轮次 ${r.round}: ${r.successes}/${r.total} 成功, ` +
          `wall=${r.wallTime}ms, avg=${r.avgTime}ms, p50=${r.p50}ms, p95=${r.p95}ms, ` +
          `rps=${r.rps}`
        );
      }

      // 如果成功率低于 50%，不再继续更高并发
      const lastRound = results[results.length - 1];
      if (lastRound && lastRound.successes / lastRound.total < 0.5) {
        console.log(`\n⚠ 并发 ${level} 成功率已低于 50%，停止递增。`);
        break;
      }
    }
  } finally {


    server.kill();
  }

  console.log('\n---\n汇总：');
  console.log('并发 | 轮次 | 成功 | 失败 | wall(ms) | avg(ms) | p50(ms) | p95(ms) | rps');
  console.log('-'.repeat(80));
  for (const r of allRows) {
    console.log(
      `${String(r.concurrency).padStart(4)} | ` +
      `${String(r.round).padStart(4)} | ` +
      `${String(r.successes).padStart(4)} | ` +
      `${String(r.failures).padStart(4)} | ` +
      `${String(r.wallTime).padStart(8)} | ` +
      `${String(r.avgTime).padStart(7)} | ` +
      `${String(r.p50).padStart(7)} | ` +
      `${String(r.p95).padStart(7)} | ` +
      `${r.rps}`
    );
  }
}

main().catch((error) => {
  console.error('fatal:', error.message);
  process.exit(1);
});
