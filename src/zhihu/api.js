class ZhihuApiError extends Error {
  constructor(code, data, message) {
    super(message || `Zhihu API error code=${code}`);
    this.name = 'ZhihuApiError';
    this.code = code;
    this.data = data;
  }
}

class TokenInvalidError extends ZhihuApiError {
  constructor(data) { super(401, data, 'Zhihu access_token invalid or expired'); this.name = 'TokenInvalidError'; }
}
class AccessDeniedError extends ZhihuApiError {
  constructor(data) { super(403, data, 'Zhihu API access denied'); this.name = 'AccessDeniedError'; }
}
class UserNotFoundError extends ZhihuApiError {
  constructor(data) { super(404, data, 'Zhihu user not found'); this.name = 'UserNotFoundError'; }
}

function apiBase() {
  return process.env.ZHIHU_API_BASE || 'https://openapi.zhihu.com';
}

// 知乎 OpenAPI 所有错误都是 HTTP 200，看 body.code(0 = ok)。
async function zhihuFetch(path, opts = {}) {
  const url = path.startsWith('http') ? path : apiBase() + path;
  const res = await fetch(url, opts);

  // 极少数情况下知乎也会用真实的 4xx/5xx —— 直接抛
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ZhihuApiError(res.status, text, `Zhihu HTTP ${res.status}`);
  }

  let data;
  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('application/json')) {
    data = await res.json();
  } else {
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  }

  // access_token 响应没有 code 字段，正常返回 { access_token, ... }
  if (data && typeof data.code === 'number' && data.code !== 0) {
    switch (data.code) {
      case 401: throw new TokenInvalidError(data);
      case 403: throw new AccessDeniedError(data);
      case 404: throw new UserNotFoundError(data);
      default:  throw new ZhihuApiError(data.code, data, data.message || data.msg);
    }
  }
  return data;
}

function authHeader(token) {
  // 知乎 OpenAPI 当前用标准 OAuth2 写法；如联调失败可尝试 'Bearer; ' 变体
  return { Authorization: `Bearer ${token}` };
}

// code -> { access_token, token_type, expires_in }
async function exchangeCodeForToken(code) {
  const appId = process.env.ZHIHU_APP_ID;
  const appKey = process.env.ZHIHU_APP_KEY;
  const redirectUri = process.env.ZHIHU_REDIRECT_URI;
  if (!appId || !appKey || !redirectUri) {
    throw new Error('Missing ZHIHU_APP_ID / ZHIHU_APP_KEY / ZHIHU_REDIRECT_URI');
  }
  const body = new URLSearchParams({
    app_id: appId,
    app_key: appKey,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code,
  });
  const data = await zhihuFetch('/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!data?.access_token) {
    throw new ZhihuApiError(0, data, 'access_token missing in response');
  }
  return data;
}

async function getUser(accessToken) {
  return zhihuFetch('/user', { headers: authHeader(accessToken) });
}

// 关注动态 —— 文档里参数走 query string，默认拉一页足够过滤
async function getMoments(accessToken, { limit = 20, offset = 0 } = {}) {
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return zhihuFetch(`/user/moments?${qs}`, { headers: authHeader(accessToken) });
}

function buildAuthorizeUrl(state) {
  const base = process.env.ZHIHU_AUTHORIZE_URL || 'https://openapi.zhihu.com/authorize';
  const appId = process.env.ZHIHU_APP_ID;
  const redirectUri = process.env.ZHIHU_REDIRECT_URI;
  const qs = new URLSearchParams({
    app_id: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
  });
  if (state) qs.set('state', state);
  return `${base}?${qs}`;
}

module.exports = {
  exchangeCodeForToken,
  getUser,
  getMoments,
  buildAuthorizeUrl,
  ZhihuApiError,
  TokenInvalidError,
  AccessDeniedError,
  UserNotFoundError,
};
