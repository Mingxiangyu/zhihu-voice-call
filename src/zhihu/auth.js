const express = require('express');
const {
  exchangeCodeForToken, getUser, buildAuthorizeUrl,
  ZhihuApiError, TokenInvalidError,
} = require('./api');
const sessionStore = require('../session-store');
const { parseCookies, buildSetCookie, cookieName, cookieTtlSeconds } = require('../cookies');

// 把要回前端的用户字段挑明，敏感字段（phone_no/email）不外传
function publicUser(u) {
  if (!u) return null;
  return {
    uid: u.uid || u.id || '',
    fullname: u.fullname || u.name || '',
    avatar_path: u.avatar_path || u.avatar_url || '',
    headline: u.headline || '',
    gender: u.gender,
  };
}

function readSid(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[cookieName()] || null;
}

function buildRouter() {
  const router = express.Router();

  router.get('/oauth/login', (req, res) => {
    const state = sessionStore.createState();
    const url = buildAuthorizeUrl(state);
    console.log('[zhihu] /oauth/login → redirect, state(prefix)=' + state.slice(0, 6));
    res.redirect(302, url);
  });

  router.get('/oauth/callback', async (req, res) => {
    const { code, state } = req.query;
    console.log('[zhihu] /oauth/callback code=' + (code ? code.toString().slice(0, 8) + '...' : 'MISSING') +
      ' state=' + (state ? state.toString().slice(0, 6) + '...' : 'MISSING'));

    if (!code) {
      return res.status(400).send('Missing code');
    }

    // state 知乎可能不透传：有就严格校验，没有降级跳过
    if (state) {
      const ok = sessionStore.consumeState(state.toString());
      if (!ok) {
        console.log('[zhihu] /oauth/callback state invalid or expired');
        return res.status(400).send('Invalid state');
      }
    } else {
      console.log('[zhihu] /oauth/callback state absent, skip CSRF check (degraded)');
    }

    try {
      const tokenResp = await exchangeCodeForToken(code.toString());
      console.log('[zhihu] /access_token ok, expires_in=' + tokenResp.expires_in);

      const userResp = await getUser(tokenResp.access_token);
      const user = publicUser(userResp);
      console.log('[zhihu] /user ok, uid=' + user.uid + ' fullname=' + user.fullname);

      const sid = sessionStore.createSession({
        accessToken: tokenResp.access_token,
        expiresInSec: tokenResp.expires_in,
        user,
      });

      res.setHeader('Set-Cookie', buildSetCookie(cookieName(), sid, {
        maxAge: cookieTtlSeconds(),
        httpOnly: true,
        sameSite: 'Lax',
        secure: false,
      }));
      res.redirect(302, '/');
    } catch (err) {
      console.error('[zhihu] /oauth/callback failed:', err.message);
      if (err instanceof TokenInvalidError) {
        return res.status(401).send('Authorization failed: token invalid');
      }
      if (err instanceof ZhihuApiError) {
        return res.status(502).send(`Zhihu API error: code=${err.code} ${err.message}`);
      }
      return res.status(500).send('OAuth callback failed: ' + err.message);
    }
  });

  router.get('/api/me', (req, res) => {
    const sid = readSid(req);
    const s = sessionStore.getSession(sid);
    if (!s) return res.status(401).json({ error: 'not_logged_in' });
    res.json({ user: s.user, expiresAt: s.expiresAt });
  });

  router.post('/api/logout', (req, res) => {
    const sid = readSid(req);
    if (sid) sessionStore.destroySession(sid);
    res.setHeader('Set-Cookie', buildSetCookie(cookieName(), '', {
      maxAge: 0, httpOnly: true, sameSite: 'Lax', secure: false,
    }));
    res.json({ ok: true });
  });

  return router;
}

module.exports = { buildRouter, readSid };
