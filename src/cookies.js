// 极简 cookie 工具：仅满足本项目的 sid cookie 读写场景，不引依赖。

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function buildSetCookie(name, value, { maxAge, path = '/', httpOnly = true, sameSite = 'Lax', secure = false } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (typeof maxAge === 'number') parts.push(`Max-Age=${maxAge}`);
  parts.push(`Path=${path}`);
  if (httpOnly) parts.push('HttpOnly');
  if (sameSite) parts.push(`SameSite=${sameSite}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function cookieName() {
  return process.env.SESSION_COOKIE_NAME || 'sid';
}

function cookieTtlSeconds() {
  const n = Number(process.env.SESSION_TTL_SECONDS);
  return Number.isFinite(n) && n > 0 ? n : 86400;
}

module.exports = { parseCookies, buildSetCookie, cookieName, cookieTtlSeconds };
