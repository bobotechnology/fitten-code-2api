/**
 * 高并发 token 生成速率压测
 *
 * 自动启动代理服务，使用 stream=true + include_usage=true，统计：
 * - 对话是否成功
 * - completion_tokens 总数
 * - aggregate tokens/sec（总 completion_tokens / 总墙钟时间）
 * - per-request avg tokens/sec（单请求 completion_tokens / 单请求耗时）
 *
 * 用法：
 *   PowerShell:
 *   $env:FITTEN_USERNAME="..."; $env:FITTEN_PASSWORD="..."; node scripts/check-token-throughput.js
 *
 * 环境变量：
 *   FITTEN_USERNAME              Fitten 登录账号（必填）
 *   FITTEN_PASSWORD              Fitten 登录密码（必填）
 *   TOKEN_BENCH_PORT             代理端口，默认 3096
 *   TOKEN_BENCH_LEVELS           并发级别，默认 1,4,8,16,32
 *   TOKEN_BENCH_ROUNDS           每级轮次，默认 2
 *   TOKEN_BENCH_TIMEOUT_MS       单请求超时，默认 180000
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const PORT = Number(process.env.TOKEN_BENCH_PORT || 3096);
const LEVELS = (process.env.TOKEN_BENCH_LEVELS || '1,4,8,16,32').split(',').map((v) => Number(v.trim())).filter(Boolean);
const ROUNDS = Number(process.env.TOKEN_BENCH_ROUNDS || 2);
const TIMEOUT_MS = Number(process.env.TOKEN_BENCH_TIMEOUT_MS || 180000);

if (!process.env.FITTEN_USERNAME || !process.env.FITTEN_PASSWORD) {
  console.error('请先设置 FITTEN_USERNAME 和 FITTEN_PASSWORD 环境变量');
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
    let settled = false;

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(`server exited early: ${code}; stderr=${stderr.slice(0, 1000)}`));
    });

    child.stdout.once('data', () => {
      if (settled) return;
      settled = true;
      resolve(child);
    });

    setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (_) {}
      reject(new Error(`server start timeout; stderr=${stderr.slice(0, 1000)}`));
    }, 10000);
  });
}

function parseSsePayload(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const events = [];
  let current = [];

  for (const line of lines) {
    if (!line.trim()) {
      if (current.length) {
        events.push(current.join('\n'));
        current = [];
      }
      continue;
    }
    if (line.startsWith('data: ')) {
      current.push(line.slice(6));
    }
  }

  if (current.length) events.push(current.join('\n'));
  return events;
}

function sendStreamingRequest() {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const body = JSON.stringify({
      model: 'fitten-code',
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        {
          role: 'user',
          content: '请输出一段大约300字的中文说明，主题是“高并发代理服务的稳定性测试”，分成3段，每段2到3句，不要使用Markdown列表。'
        }
      ]
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
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          const elapsedMs = Date.now() - startedAt;
          const sseEvents = parseSsePayload(raw);

          let content = '';
          let completionTokens = 0;
          let promptTokens = 0;
          let totalTokens = 0;
          let doneSeen = false;
          let parseErrors = 0;

          for (const event of sseEvents) {
            if (event === '[DONE]') {
              doneSeen = true;
              continue;
            }

            try {
              const parsed = JSON.parse(event);
              const choice = parsed?.choices?.[0];
              const deltaContent = choice?.delta?.content;
              if (typeof deltaContent === 'string') content += deltaContent;

              if (parsed?.usage && typeof parsed.usage === 'object') {
                completionTokens = Number(parsed.usage.completion_tokens || 0);
                promptTokens = Number(parsed.usage.prompt_tokens || 0);
                totalTokens = Number(parsed.usage.total_tokens || 0);
              }
            } catch (_) {
              parseErrors += 1;
            }
          }

          const success = res.statusCode === 200 && doneSeen && completionTokens > 0 && content.length > 0;
          const requestTokensPerSec = completionTokens > 0 && elapsedMs > 0
            ? Number((completionTokens / (elapsedMs / 1000)).toFixed(2))
            : 0;

          resolve({
            success,
            status: res.statusCode || 0,
            elapsedMs,
            contentLength: content.length,
            promptTokens,
            completionTokens,
            totalTokens,
            requestTokensPerSec,
            doneSeen,
            parseErrors
          });
        });
      }
    );

    req.on('error', (error) => {
      resolve({
        success: false,
        status: 0,
        elapsedMs: Date.now() - startedAt,
        contentLength: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        requestTokensPerSec: 0,
        doneSeen: false,
        parseErrors: 0,
        error: error.code || error.message
      });
    });

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error('timeout'));
    });

    req.write(body);
    req.end();
  });
}

async function runLevel(concurrency) {
  const rows = [];

  for (let round = 1; round <= ROUNDS; round++) {
    const roundStart = Date.now();
    const results = await Promise.all(Array.from({ length: concurrency }, () => sendStreamingRequest()));
    const wallMs = Date.now() - roundStart;

    const successRows = results.filter((r) => r.success);
    const successCount = successRows.length;
    const failureCount = results.length - successCount;
    const totalCompletionTokens = successRows.reduce((sum, row) => sum + row.completionTokens, 0);
    const totalPromptTokens = successRows.reduce((sum, row) => sum + row.promptTokens, 0);
    const totalTokens = successRows.reduce((sum, row) => sum + row.totalTokens, 0);
    const avgLatencyMs = results.length ? Math.round(results.reduce((sum, row) => sum + row.elapsedMs, 0) / results.length) : 0;
    const sortedLatency = results.map((r) => r.elapsedMs).sort((a, b) => a - b);
    const p50LatencyMs = sortedLatency.length ? sortedLatency[Math.floor(sortedLatency.length * 0.5)] : 0;
    const p95LatencyMs = sortedLatency.length ? sortedLatency[Math.floor(sortedLatency.length * 0.95)] : 0;
    const aggregateTokensPerSec = wallMs > 0 ? Number((totalCompletionTokens / (wallMs / 1000)).toFixed(2)) : 0;
    const avgRequestTokensPerSec = successRows.length
      ? Number((successRows.reduce((sum, row) => sum + row.requestTokensPerSec, 0) / successRows.length).toFixed(2))
      : 0;

    rows.push({
      round,
      concurrency,
      requests: results.length,
      successCount,
      failureCount,
      wallMs,
      avgLatencyMs,
      p50LatencyMs,
      p95LatencyMs,
      totalPromptTokens,
      totalCompletionTokens,
      totalTokens,
      aggregateTokensPerSec,
      avgRequestTokensPerSec
    });
  }

  return rows;
}

async function main() {
  console.log('fitten-code-2api token 吞吐量压测');
  console.log(`端口: ${PORT}`);
  console.log(`并发级别: ${LEVELS.join(', ')}`);
  console.log(`每级别轮次: ${ROUNDS}`);
  console.log('正在启动服务...');

  const server = await startServer();
  const allRows = [];

  try {
    console.log('服务已启动\n---');
    for (const level of LEVELS) {
      console.log(`\n▶ 并发 ${level} ...`);
      const rows = await runLevel(level);
      allRows.push(...rows);

      for (const row of rows) {
        console.log(
          `  轮次 ${row.round}: 成功 ${row.successCount}/${row.requests}, ` +
          `completion_tokens=${row.totalCompletionTokens}, wall=${row.wallMs}ms, ` +
          `agg_tps=${row.aggregateTokensPerSec}, avg_req_tps=${row.avgRequestTokensPerSec}, ` +
          `avg=${row.avgLatencyMs}ms, p50=${row.p50LatencyMs}ms, p95=${row.p95LatencyMs}ms`
        );
      }

      const last = rows[rows.length - 1];
      if (last && last.successCount / last.requests < 0.8) {
        console.log(`\n⚠ 并发 ${level} 成功率已低于 80%，停止递增。`);
        break;
      }
    }
  } finally {


    try { server.kill(); } catch (_) {}
  }

  console.log('\n---\n汇总：');
  console.log('并发 | 轮次 | 成功 | 失败 | completion_tokens | wall(ms) | agg_tps | avg_req_tps | avg(ms) | p50 | p95');
  console.log('-'.repeat(120));
  for (const row of allRows) {
    console.log(
      `${String(row.concurrency).padStart(4)} | ` +
      `${String(row.round).padStart(4)} | ` +
      `${String(row.successCount).padStart(4)} | ` +
      `${String(row.failureCount).padStart(4)} | ` +
      `${String(row.totalCompletionTokens).padStart(17)} | ` +
      `${String(row.wallMs).padStart(8)} | ` +
      `${String(row.aggregateTokensPerSec).padStart(7)} | ` +
      `${String(row.avgRequestTokensPerSec).padStart(11)} | ` +
      `${String(row.avgLatencyMs).padStart(7)} | ` +
      `${String(row.p50LatencyMs).padStart(4)} | ` +
      `${String(row.p95LatencyMs).padStart(4)}`
    );
  }
}

main().catch((error) => {
  console.error('fatal:', error.message);
  process.exit(1);
});
