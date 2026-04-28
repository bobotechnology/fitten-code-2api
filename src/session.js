const { createHttpError } = require('./errors');
const {
  FITTEN_BASE_URL,
  buildBrowserHeaders,
  buildAuthorizedHeaders,
  fetchWithTimeout,
  parseJsonResponse,
  getNonEmptyString
} = require('./helpers');

const ACCESS_TOKEN_REFRESH_MARGIN_MS = Number(process.env.FITTEN_ACCESS_TOKEN_REFRESH_MARGIN_MS || 60 * 1000);

const sessionCache = new Map();

async function getFittenSession(credentials, options = {}) {
  const cacheKey = credentials.username;
  if (!options.forceLogin && sessionCache.has(cacheKey)) {
    const cachedSession = sessionCache.get(cacheKey);
    if (isSessionUsable(cachedSession)) {
      return cachedSession;
    }
    sessionCache.delete(cacheKey);
  }

  const session = await loginToFitten(credentials.username, credentials.password);
  sessionCache.set(cacheKey, session);
  return session;
}

async function loginToFitten(username, password) {
  const response = await fetchWithTimeout(`${FITTEN_BASE_URL}/codeuser/auth/login`, {
    method: 'POST',
    headers: buildBrowserHeaders({
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify({ username, password })
  });

  const text = await response.text();
  if (!response.ok) {
    throw createHttpError(response.status, `fitten login failed: ${text.slice(0, 500)}`, {
      type: response.status >= 500 ? 'server_error' : 'invalid_request_error',
      code: response.status === 401 ? 'invalid_credentials' : 'login_failed'
    });
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw createHttpError(502, `fitten login returned invalid json: ${text.slice(0, 500)}`, {
      type: 'server_error',
      code: 'invalid_upstream_json'
    });
  }

  const accessToken = data.access_token;
  const refreshToken = data.refresh_token;
  const userId = data.user_info && data.user_info.user_id;

  if (!accessToken || !refreshToken || !userId) {
    throw createHttpError(502, 'fitten login response missing access_token, refresh_token or user_id', {
      type: 'server_error',
      code: 'invalid_login_payload'
    });
  }

  const session = {
    username,
    accessToken,
    refreshToken,
    userId,
    accessTokenExpiresAt: getJwtExpiryTime(accessToken),
    refreshTokenExpiresAt: getJwtExpiryTime(refreshToken),
    userInfo: data.user_info || {}
  };

  await warmUpFittenSession(session);
  return session;
}

async function warmUpFittenSession(session) {
  const authHeaders = buildAuthorizedHeaders(session.accessToken);
  await Promise.allSettled([
    fetch(`${FITTEN_BASE_URL}/codeuser/user_info`, {
      method: 'GET',
      headers: authHeaders
    }),
    fetch(`${FITTEN_BASE_URL}/codeuser/get_notifications`, {
      method: 'POST',
      headers: buildAuthorizedHeaders(session.accessToken, {
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify({ page: 1, page_size: 20 })
    })
  ]);
}

function isSessionUsable(session) {
  if (!session || typeof session !== 'object') return false;
  if (!session.userId) return false;
  if (!session.accessToken && !session.refreshToken) return false;
  if (session.accessToken && !isAccessTokenExpired(session.accessTokenExpiresAt)) return true;
  if (session.refreshToken && !isRefreshTokenExpired(session.refreshTokenExpiresAt)) return true;
  return false;
}

function isAccessTokenExpired(expiresAt) {
  return isTokenExpired(expiresAt, ACCESS_TOKEN_REFRESH_MARGIN_MS);
}

function isRefreshTokenExpired(expiresAt) {
  return isTokenExpired(expiresAt, 0);
}

function isTokenExpired(expiresAt, marginMs = 0) {
  if (!expiresAt) return false;
  return Date.now() >= expiresAt - marginMs;
}

function getJwtExpiryTime(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;

  try {
    const payload = token.split('.')[1];
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    const json = Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8');
    const data = JSON.parse(json);
    if (typeof data.exp !== 'number' || !Number.isFinite(data.exp)) return null;
    return data.exp * 1000;
  } catch (error) {
    return null;
  }
}

function clearCachedSession(credentials) {
  if (!credentials || !credentials.username) return;
  sessionCache.delete(credentials.username);
}

async function ensureValidAccessToken(session, credentials) {
  if (!session || typeof session !== 'object') {
    throw createHttpError(401, 'fitten session is unavailable');
  }

  if (session.accessToken && !isAccessTokenExpired(session.accessTokenExpiresAt)) {
    return session;
  }

  return refreshSessionTokens(session, credentials);
}

async function refreshSessionTokens(session, credentials) {
  if (session.refreshToken && !isRefreshTokenExpired(session.refreshTokenExpiresAt)) {
    const accessRefresh = await refreshAccessToken(session.refreshToken);
    return updateSessionTokens(credentials, session, accessRefresh);
  }

  clearCachedSession(credentials);
  throw createHttpError(401, 'fitten refresh token is unavailable or expired', {
    type: 'invalid_request_error',
    code: 'refresh_token_unavailable'
  });
}

async function refreshAccessToken(refreshToken) {
  const response = await fetchWithTimeout(`${FITTEN_BASE_URL}/codeuser/auth/refresh_access_token`, {
    method: 'POST',
    headers: buildBrowserHeaders({
      Authorization: `Bearer ${refreshToken}`,
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify({})
  });

  const data = await parseJsonResponse(response, 'fitten refresh_access_token');
  if (!response.ok) {
    const detail = typeof data?.detail === 'string' ? data.detail : '';
    if ((response.status === 404 && detail === 'User not found') || response.status === 401) {
      throw createHttpError(response.status, `fitten refresh_access_token failed: ${detail || response.status}`, {
        type: 'invalid_request_error',
        code: response.status === 401 ? 'refresh_token_invalid' : 'refresh_user_not_found'
      });
    }
    throw createHttpError(response.status, `fitten refresh_access_token failed: ${JSON.stringify(data).slice(0, 500)}`, {
      type: response.status >= 500 ? 'server_error' : 'invalid_request_error',
      code: 'refresh_access_token_failed'
    });
  }

  return data;
}

function updateSessionTokens(credentials, session, data) {
  const nextAccessToken = getNonEmptyString(data && data.access_token) || session.accessToken;
  const nextRefreshToken = getNonEmptyString(data && data.refresh_token) || session.refreshToken;

  if (!nextAccessToken || !nextRefreshToken) {
    clearCachedSession(credentials);
    throw createHttpError(502, 'fitten refresh response missing access_token or refresh_token');
  }

  const nextSession = {
    ...session,
    accessToken: nextAccessToken,
    refreshToken: nextRefreshToken,
    accessTokenExpiresAt: getJwtExpiryTime(nextAccessToken),
    refreshTokenExpiresAt: getJwtExpiryTime(nextRefreshToken)
  };

  if (data && data.user_info && typeof data.user_info === 'object') {
    nextSession.userInfo = data.user_info;
    if (data.user_info.user_id) nextSession.userId = data.user_info.user_id;
  }

  if (!nextSession.userId) {
    clearCachedSession(credentials);
    throw createHttpError(502, 'fitten refresh response missing user_id');
  }

  if (credentials && credentials.username) {
    sessionCache.set(credentials.username, nextSession);
  }

  return nextSession;
}

module.exports = {
  sessionCache,
  getFittenSession,
  clearCachedSession,
  ensureValidAccessToken,
  refreshSessionTokens
};
