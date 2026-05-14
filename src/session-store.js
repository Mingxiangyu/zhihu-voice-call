const crypto = require('crypto');

// sid -> { accessToken, expiresAt(ms), user, createdAt(ms) }
const sessions = new Map();

// 同时维护 state -> { createdAt }，用于 OAuth CSRF 校验
const states = new Map();
const STATE_TTL_MS = 5 * 60 * 1000;

function genId(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function createSession({ accessToken, expiresInSec, user }) {
  const sid = genId();
  sessions.set(sid, {
    accessToken,
    expiresAt: Date.now() + (expiresInSec || 3600) * 1000,
    user,
    createdAt: Date.now(),
  });
  return sid;
}

function getSession(sid) {
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    sessions.delete(sid);
    return null;
  }
  return s;
}

function destroySession(sid) {
  if (!sid) return;
  sessions.delete(sid);
}

function createState() {
  const state = genId(16);
  states.set(state, { createdAt: Date.now() });
  return state;
}

// state 一次性、5 分钟过期
function consumeState(state) {
  if (!state) return false;
  const s = states.get(state);
  if (!s) return false;
  states.delete(state);
  return Date.now() - s.createdAt <= STATE_TTL_MS;
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now > s.expiresAt) sessions.delete(sid);
  }
  for (const [k, v] of states) {
    if (now - v.createdAt > STATE_TTL_MS) states.delete(k);
  }
}, 10 * 60 * 1000).unref();

module.exports = {
  createSession,
  getSession,
  destroySession,
  createState,
  consumeState,
};
