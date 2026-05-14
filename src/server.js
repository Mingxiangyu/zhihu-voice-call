require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const VolcengineClient = require('./volcengine-client');
const { MessageType, ServerEventId } = require('./protocol');
const sessionStore = require('./session-store');
const { parseCookies, cookieName } = require('./cookies');
const authRouter = require('./zhihu/auth');
const { getMoments, TokenInvalidError, ZhihuApiError } = require('./zhihu/api');
const { buildHelloText, buildSystemRole } = require('./zhihu/prompt');

const PORT = process.env.PORT || 3000;
const app = express();

app.use(express.json());
app.use(authRouter.buildRouter());

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const server = http.createServer(app);

const wss = new WebSocketServer({ server });

// 仅打印首个 TTS 音频帧的前 32 字节 hex，用于核对 PCM 格式（int16/float32）
let firstTTSLogged = false;

wss.on('connection', (browserWs, req) => {
  console.log('=== [browser] WebSocket connected ===');

  // 鉴权：从 cookie 找 session
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies[cookieName()];
  const session = sessionStore.getSession(sid);

  if (!session) {
    console.log('[browser] WS no session, closing');
    try { browserWs.send(JSON.stringify({ type: 'error', message: '未登录或登录已过期，请重新登录知乎' })); } catch {}
    browserWs.close();
    return;
  }
  console.log('[browser] WS authenticated, uid=' + session.user.uid + ' fullname=' + session.user.fullname);

  let volcClient = null;

  browserWs.on('message', async (data, isBinary) => {
    // isBinary=true = audio data from browser
    if (isBinary) {
      if (volcClient) {
        volcClient.sendAudio(Buffer.from(data));
      }
      return;
    }

    // Text = JSON control messages
    try {
      const msg = JSON.parse(data.toString());
      console.log('[browser] parsed message type=' + msg.type);
      switch (msg.type) {
        case 'start':
          console.log('[flow] stage=handleStart begin');
          await handleStart();
          console.log('[flow] stage=handleStart end');
          break;
        case 'stop':
          await handleStop();
          break;
      }
    } catch (err) {
      console.error('[browser] invalid message:', err.message);
    }
  });

  browserWs.on('close', async () => {
    console.log('=== [browser] WebSocket disconnected ===');
    if (volcClient) {
      await volcClient.disconnect().catch(() => {});
      volcClient = null;
    }
  });

  async function handleStart() {
    if (volcClient) {
      console.log('[flow] closing existing volc client');
      await volcClient.disconnect().catch(() => {});
      volcClient = null;
    }

    const appId = process.env.VOLC_APP_ID;
    const accessToken = process.env.VOLC_ACCESS_KEY;

    if (!appId || !accessToken) {
      console.log('[flow] credentials missing, sending error');
      browserWs.send(JSON.stringify({
        type: 'error',
        message: '.env 缺少 VOLC_APP_ID 或 VOLC_ACCESS_KEY',
      }));
      return;
    }

    // 拉关注动态 → 拼开场白
    let momentsData = [];
    try {
      const momentsResp = await getMoments(session.accessToken);
      momentsData = momentsResp?.data || momentsResp?.moments || [];
      console.log('[zhihu] /user/moments ok, raw count=' + momentsData.length);
    } catch (err) {
      if (err instanceof TokenInvalidError) {
        console.log('[zhihu] token invalid, destroying session');
        sessionStore.destroySession(sid);
        browserWs.send(JSON.stringify({ type: 'error', message: '知乎登录已过期，请重新登录' }));
        browserWs.close();
        return;
      }
      console.log('[zhihu] /user/moments failed (degraded to empty):', err.message);
    }

    const fullname = session.user.fullname || '朋友';
    const helloText = buildHelloText(fullname, momentsData);
    const openingMode = (process.env.ZHIHU_OPENING_MODE || 'say_hello').toLowerCase();
    const systemRole = buildSystemRole(fullname, helloText, openingMode);

    console.log('[flow] opening mode=' + openingMode +
      ' helloTextLen=' + helloText.length +
      ' systemRoleLen=' + systemRole.length);
    console.log('[flow] helloText preview: ' + helloText.replace(/\n/g, ' | ').slice(0, 120));

    console.log('[flow] creating VolcengineClient');
    volcClient = new VolcengineClient({
      appId,
      accessToken,
      onMessage: (frame) => handleVolcMessage(frame),
      onError: (err) => {
        console.error('[volc] error:', err.message);
        browserWs.send(JSON.stringify({ type: 'error', message: err.message }));
      },
      onClose: (code, reason) => {
        console.log('[volc] disconnected:', code, reason);
        browserWs.send(JSON.stringify({ type: 'stopped' }));
        volcClient = null;
      },
    });

    try {
      console.log('[flow] stage=volc.connect begin');
      await volcClient.connect();
      console.log('[flow] stage=volc.connect done');

      console.log('[flow] stage=volc.startSession begin');
      await volcClient.startSession({
        model: process.env.MODEL || '1.2.1.1',
        systemRole,
        botName: '刘看山',
        voiceType: process.env.TTS_VOICE_TYPE || '',
      });
      console.log('[flow] stage=volc.startSession done');

      browserWs.send(JSON.stringify({ type: 'ready', user: session.user }));

      // say_hello 模式：主动开口
      if (openingMode === 'say_hello' && volcClient) {
        // 延一拍，让 sessionStarted 之后状态稳定
        setTimeout(() => {
          if (volcClient) volcClient.sayHello(helloText);
        }, 200);
      }
    } catch (err) {
      console.error('[flow] ERROR:', err.message);
      console.error('[flow] stack:', err.stack);
      browserWs.send(JSON.stringify({ type: 'error', message: err.message }));
      if (volcClient) {
        await volcClient.disconnect().catch(() => {});
        volcClient = null;
      }
    }
  }

  async function handleStop() {
    console.log('[flow] handleStop');
    if (volcClient) {
      await volcClient.disconnect().catch(() => {});
      volcClient = null;
    }
    browserWs.send(JSON.stringify({ type: 'stopped' }));
  }

  function handleVolcMessage(frame) {
    const msgType = frame.header.messageType;

    // Text events from server (ASR, Chat, TTS status)
    if (msgType === MessageType.FULL_SERVER_RESPONSE && frame.event) {
      const event = frame.event;
      const payload = frame.payload;

      switch (event) {
        case ServerEventId.ASR_INFO:
          browserWs.send(JSON.stringify({ type: 'asr_info' }));
          break;
        case ServerEventId.ASR_RESPONSE:
          browserWs.send(JSON.stringify({
            type: 'asr',
            event,
            text: payload?.results?.[0]?.text || payload?.text || '',
            is_interim: payload?.results?.[0]?.is_interim ?? false,
          }));
          break;
        case ServerEventId.ASR_ENDED:
          browserWs.send(JSON.stringify({ type: 'asr_end' }));
          break;
        case ServerEventId.CHAT_RESPONSE:
          browserWs.send(JSON.stringify({
            type: 'chat',
            text: payload?.content || payload?.text || '',
            is_final: payload?.is_final || false,
          }));
          break;
        case ServerEventId.CHAT_ENDED:
          browserWs.send(JSON.stringify({ type: 'chat_ended' }));
          break;
        case ServerEventId.TTS_SENTENCE_START:
          browserWs.send(JSON.stringify({
            type: 'tts',
            event,
            text: payload?.text || '',
            is_final: false,
          }));
          break;
        case ServerEventId.TTS_ENDED:
          browserWs.send(JSON.stringify({
            type: 'tts',
            event,
            text: '',
            is_final: true,
          }));
          break;
        default:
          browserWs.send(JSON.stringify({
            type: 'event',
            event,
            payload,
          }));
      }
    }

    // Audio response from server (TTS audio data)
    if (msgType === MessageType.AUDIO_ONLY_RESPONSE) {
      const audioData = frame.payloadRaw;
      if (!firstTTSLogged && audioData && audioData.length > 0) {
        console.log('[tts] first audio frame size=', audioData.length,
          'hex(0..32)=', audioData.slice(0, 32).toString('hex'));
        firstTTSLogged = true;
      }
      browserWs.send(audioData);
    }

    // Error from server
    if (msgType === MessageType.ERROR) {
      const errText = frame.payloadRaw ? frame.payloadRaw.toString('utf-8') : '';
      console.log('[volc] ERROR frame code=' + frame.code + ' body=' + errText);
      browserWs.send(JSON.stringify({
        type: 'error',
        message: frame.payload?.error || errText || 'Unknown error',
      }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log('[config] PORT=', PORT);
  console.log('[config] VOLC_APP_ID=', process.env.VOLC_APP_ID ? `"${process.env.VOLC_APP_ID}"` : 'EMPTY');
  console.log('[config] VOLC_ACCESS_KEY=', process.env.VOLC_ACCESS_KEY ? `set (${process.env.VOLC_ACCESS_KEY.length} chars)` : 'EMPTY');
  console.log('[config] MODEL=', process.env.MODEL || 'default');
  console.log('[config] ZHIHU_APP_ID=', process.env.ZHIHU_APP_ID || 'EMPTY');
  console.log('[config] ZHIHU_APP_KEY=', process.env.ZHIHU_APP_KEY ? `set (${process.env.ZHIHU_APP_KEY.length} chars)` : 'EMPTY');
  console.log('[config] ZHIHU_REDIRECT_URI=', process.env.ZHIHU_REDIRECT_URI || 'EMPTY');
  console.log('[config] ZHIHU_OPENING_MODE=', process.env.ZHIHU_OPENING_MODE || 'say_hello (default)');
});
