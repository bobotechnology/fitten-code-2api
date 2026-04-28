const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');

const FITTEN_BASE_URL = process.env.FITTEN_BASE_URL || 'https://fc.fittenlab.cn';
const FITTEN_USERNAME = process.env.FITTEN_USERNAME;
const FITTEN_PASSWORD = process.env.FITTEN_PASSWORD;
const PORT = Number(process.env.PORT || 3014);
const FORCE_REFRESH_MARGIN_MS = String(process.env.FITTEN_ACCESS_TOKEN_REFRESH_MARGIN_MS || 999999999999);

function redactToken(token) {
  if (typeof token !== 'string' || !token) return null;
  if (token.length <= 16) return '[redacted]';
  return `${token.slice(0, 8)}...[redacted]...${token.slice(-8)}`;
}

function summarizeTokenShape(token) {
  if (typeof token !== 'string' || !token) {
    return {
      present: false,
      jwtLike: false,
      dotCount: 0,
      length: 0,
      preview: null
    };
  }

  const dotCount = (token.match(/\./g) || []).length;
  return {
    present: true,
    jwtLike: dotCount === 2,
    dotCount,
    length: token.length,
    preview: redactToken(token)
  };
}

async function readJson(response, label) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`${label} returned invalid json: ${text.slice(0, 500)}`);
  }
}

async function login() {
  const response = await fetch(`${FITTEN_BASE_URL}/codeuser/auth/login`, {
    method: 'POST',
    headers: {
      Referer: `${FITTEN_BASE_URL}/`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ username: FITTEN_USERNAME, password: FITTEN_PASSWORD })
  });

  const data = await readJson(response, 'login');
  if (!response.ok) {
    throw new Error(`login failed: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return data;
}

async function refreshAccessToken(refreshToken) {
  const response = await fetch(`${FITTEN_BASE_URL}/codeuser/auth/refresh_access_token`, {
    method: 'POST',
    headers: {
      Referer: `${FITTEN_BASE_URL}/`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      Authorization: `Bearer ${refreshToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({})
  });

  const data = await readJson(response, 'refresh_access_token');
  return { status: response.status, ok: response.ok, data };
}

function requestProxyChat() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
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
          resolve({ status: res.statusCode, body: data });
        });
      }
    );

    req.on('error', reject);
    req.write(
      JSON.stringify({
        model: 'fitten-code',
        messages: [{ role: 'user', content: '你好，请只回复 ok' }],
        stream: false
      })
    );
    req.end();
  });
}

async function verifyProxyForcedRefresh() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectRoot, 'index.js')], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PORT: String(PORT),
        FITTEN_USERNAME: FITTEN_USERNAME,
        FITTEN_PASSWORD: FITTEN_PASSWORD,
        FITTEN_ACCESS_TOKEN_REFRESH_MARGIN_MS: FORCE_REFRESH_MARGIN_MS
      }
    });

    let stderr = '';
    let settled = false;

    const done = (error, result) => {
      if (settled) return;
      settled = true;
      child.kill();
      if (error) reject(error);
      else resolve(result);
    };

    child.stdout.once('data', async () => {
      try {
        const result = await requestProxyChat();
        done(null, result);
      } catch (error) {
        done(error);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('exit', (code) => {
      if (!settled && code !== null) {
        done(new Error(`proxy exited early: ${code}; stderr=${stderr.slice(0, 1000)}`));
      }
    });

    setTimeout(() => {
      done(new Error(`proxy start timed out; stderr=${stderr.slice(0, 1000)}`));
    }, 20000);
  });
}

async function main() {
  const loginResult = await login();
  const refreshToken = loginResult.refresh_token;

  const firstAccessRefresh = await refreshAccessToken(refreshToken);
  const secondAccessRefresh = await refreshAccessToken(refreshToken);

  const proxyResult = await verifyProxyForcedRefresh();
  const proxyBody = (() => {
    try {
      return JSON.parse(proxyResult.body);
    } catch (error) {
      return proxyResult.body;
    }
  })();

  const report = {
    baseUrl: FITTEN_BASE_URL,
    username: FITTEN_USERNAME,
    login: {
      ok: true,
      userId: loginResult.user_info && loginResult.user_info.user_id,
      accessToken: summarizeTokenShape(loginResult.access_token),
      refreshToken: summarizeTokenShape(refreshToken)
    },
    refreshAccessToken: {
      firstCall: {
        status: firstAccessRefresh.status,
        ok: firstAccessRefresh.ok,
        accessToken: summarizeTokenShape(firstAccessRefresh.data && firstAccessRefresh.data.access_token),
        refreshToken: summarizeTokenShape(firstAccessRefresh.data && firstAccessRefresh.data.refresh_token),
        detail: firstAccessRefresh.data && firstAccessRefresh.data.detail
      },
      secondCallWithOriginalRefreshToken: {
        status: secondAccessRefresh.status,
        ok: secondAccessRefresh.ok,
        accessToken: summarizeTokenShape(secondAccessRefresh.data && secondAccessRefresh.data.access_token),
        refreshToken: summarizeTokenShape(secondAccessRefresh.data && secondAccessRefresh.data.refresh_token),
        detail: secondAccessRefresh.data && secondAccessRefresh.data.detail
      }
    },
    proxyForcedRefresh: {
      status: proxyResult.status,
      ok: proxyResult.status === 200,
      responsePreview:
        typeof proxyBody === 'string'
          ? proxyBody.slice(0, 1000)
          : JSON.stringify(proxyBody).slice(0, 1000)
    }
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        error: error.message,
        stack: error.stack
      },
      null,
      2
    )
  );
  process.exit(1);
});
