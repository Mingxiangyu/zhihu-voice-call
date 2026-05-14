const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const {
  buildTextFrame, buildAudioFrame, parseFrame,
  EventId, MessageType,
} = require('./protocol');

const VOLC_WS_URL = 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue';
const VOLC_RESOURCE_ID = 'volc.speech.dialog';
const VOLC_APP_KEY = process.env.VOLC_APP_KEY || '';

class VolcengineClient {
  constructor({ appId, accessToken, onMessage, onError, onClose }) {
    this.appId = appId;
    this.accessToken = accessToken;
    this.onMessage = onMessage;
    this.onError = onError;
    this.onClose = onClose;

    this.ws = null;
    this.connectId = null;
    this.sessionId = null;
    this.audioSequence = 0;
    this.connected = false;
    this.sessionStarted = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.connectId = uuidv4();

      console.log('[volc-client] stage=connecting');
      console.log('[volc-client] url=', VOLC_WS_URL);
      console.log('[volc-client] headers:', {
        'X-Api-Resource-Id': VOLC_RESOURCE_ID,
        'X-Api-App-Key': VOLC_APP_KEY.substring(0, 8) + '...',
        'X-Api-App-ID': this.appId,
        'X-Api-Access-Key': this.accessToken.substring(0, 8) + '...',
      });

      const ws = new WebSocket(VOLC_WS_URL, {
        rejectUnauthorized: true,
        headers: {
          'X-Api-Resource-Id': VOLC_RESOURCE_ID,
          'X-Api-App-Key': VOLC_APP_KEY,
          'X-Api-App-ID': this.appId,
          'X-Api-Access-Key': this.accessToken,
        },
      });

      ws.on('open', async () => {
        console.log('[volc-client] stage=ws.open');
        this.ws = ws;
        try {
          console.log('[volc-client] stage=sendStartConnection begin');
          await this._sendStartConnection();
          console.log('[volc-client] stage=sendStartConnection done');
          // Now set up general message handler
          ws.on('message', (data, isBinary) => {
            this._handleMessage(data, isBinary);
          });
          this.connected = true;
          resolve();
        } catch (err) {
          console.log('[volc-client] stage=sendStartConnection FAILED:', err.message);
          reject(err);
        }
      });

      ws.on('error', (err) => {
        console.log('[volc-client] stage=ws.error:', err.message);
        this.onError?.(err);
        reject(err);
      });

      ws.on('close', (code, reason) => {
        console.log('[volc-client] stage=ws.close code=', code, 'reason=', reason?.toString());
        this.connected = false;
        this.sessionStarted = false;
        this.onClose?.(code, reason?.toString());
      });

      ws.on('unexpected-response', (req, res) => {
        console.log('[volc-client] stage=ws.unexpected-response status=', res.statusCode);
        let body = '';
        res.on('data', (chunk) => { body += chunk.toString(); });
        res.on('end', () => {
          console.log('[volc-client] stage=ws.unexpected-response body=', body);
        });
        reject(new Error(`Unexpected response: ${res.statusCode}`));
      });
    });
  }

  async startSession(config = {}) {
    if (!this.connected || !this.ws) throw new Error('Not connected');

    return new Promise((resolve, reject) => {
      this.sessionId = uuidv4();
      this.audioSequence = 3;

      let sessionTimeout = null;
      let sessionSettled = false;
      const cleanupSession = () => {
        if (sessionSettled) return;
        sessionSettled = true;
        if (sessionTimeout) { clearTimeout(sessionTimeout); sessionTimeout = null; }
        this._removeSessionHandler();
      };

      const sessionConfig = {
        session_id: this.sessionId,
        model: config.model || '1.2.1.1',
        dialog: {
          system_role: config.systemRole || '',
          bot_name: config.botName || '刘看山',
          ...(config.dialog || {}),
        },
        asr: {
          sample_rate: 16000,
          format: 'pcm',
          ...(config.asr || {}),
        },
        tts: {
          voice_type: config.voiceType || '',
          audio_config: {
            channel: 1,
            format: 'pcm',
            sample_rate: 24000,
            ...(config.ttsAudioConfig || {}),
          },
        },
      };

      console.log('[volc-client] stage=startSession config:', JSON.stringify(sessionConfig).substring(0, 200));

      // Listen for session started confirmation
      const sessionHandler = (frame) => {
        console.log('[volc-client] stage=sessionHandler event=', frame.event,
          'msgType=' + frame.header.messageType.toString(16));
        // Text response from server (event is null for text msgs)
        if (frame.event === null) {
          console.log('[volc-client] stage=session text response:', JSON.stringify(frame.payload).substring(0, 200));
          cleanupSession();
          this.sessionStarted = true;
          resolve(frame.payload);
          return;
        }
        // Binary protocol response
        if (frame.header.messageType === MessageType.FULL_SERVER_RESPONSE &&
            frame.event === EventId.START_SESSION) {
          cleanupSession();
          this.sessionStarted = true;
          console.log('[volc-client] stage=session started OK');
          resolve(frame.payload);
        } else if (frame.header.messageType === MessageType.FULL_SERVER_RESPONSE &&
            frame.event === 150) {
          // Server sends event 150 for SessionStarted
          cleanupSession();
          this.sessionStarted = true;
          console.log('[volc-client] stage=session started OK (event 150)');
          resolve(frame.payload);
        } else if (frame.header.messageType === MessageType.ERROR) {
          cleanupSession();
          console.log('[volc-client] stage=session ERROR:', JSON.stringify(frame.payload));
          reject(new Error(`Session error: ${JSON.stringify(frame.payload)}`));
        }
      };
      this._sessionHandler = sessionHandler;

      const frame = buildTextFrame(EventId.START_SESSION, sessionConfig, { sessionId: this.sessionId });
      console.log('[volc-client] stage=sending StartSession frame, size=' + frame.length);
      this.ws.send(frame);

      // Timeout if no response
      sessionTimeout = setTimeout(() => {
        if (sessionSettled) return;
        cleanupSession();
        if (!this.sessionStarted) {
          reject(new Error('Session start timeout'));
        }
      }, 15000);
    });
  }

  _removeSessionHandler() {
    this._sessionHandler = null;
  }

  sendAudio(audioData) {
    if (!this.sessionStarted || !this.ws) return;
    const sequence = this.audioSequence++;
    const frame = buildAudioFrame(audioData, sequence, false, this.sessionId);
    this.ws.send(frame);
  }

  // 让模型主动开口说一段固定文本（开场白用）
  // 联调若火山返回 ERROR 帧（event 300 不识别），上层应切换 system_role 兜底模式
  sayHello(text) {
    if (!this.sessionStarted || !this.ws) return;
    const payload = { session_id: this.sessionId, content: text };
    const frame = buildTextFrame(EventId.SAY_HELLO, payload, { sessionId: this.sessionId });
    console.log('[volc-client] stage=sayHello sending, textLen=' + text.length);
    this.ws.send(frame);
  }

  async finishSession() {
    if (!this.sessionStarted || !this.ws) return;

    return new Promise((resolve) => {
      const payload = { session_id: this.sessionId };
      const frame = buildTextFrame(EventId.FINISH_SESSION, payload, { sessionId: this.sessionId });
      this.ws.send(frame);
      this.sessionStarted = false;
      resolve();
    });
  }

  async disconnect() {
    try {
      await this.finishSession();
    } catch (_) {}

    try {
      if (this.ws && this.connected) {
        const payload = { connect_id: this.connectId };
        const frame = buildTextFrame(EventId.FINISH_CONNECTION, payload, { connectId: this.connectId });
        this.ws.send(frame);
      }
    } catch (_) {}

    this.connected = false;
    this.sessionStarted = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  _sendStartConnection() {
    return new Promise((resolve, reject) => {
      const payload = { connect_id: this.connectId };
      console.log('[volc-client] stage=sendStartConnection payload:', JSON.stringify(payload));

      let timeoutHandle = null;
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
        if (this.ws) this.ws.removeListener('message', handler);
      };

      // Wait for connection confirmation — server responds with a UUID text message
      const handler = (data, isBinary) => {
        // Text message = connection confirmed (UUID or JSON)
        if (!isBinary) {
          const text = data.toString().trim();
          console.log('[volc-client] stage=connection text response:', text);
          cleanup();
          resolve({ connect_id: text });
          return;
        }

        // Binary frame = try protocol parsing
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

        // Server may send UUID as binary frame — try text conversion first
        const asText = buf.toString('utf-8').replace(/\0/g, '').trim();
        if (/^[0-9a-f-]{32,36}$/i.test(asText)) {
          console.log('[volc-client] stage=connection uuid from binary:', asText);
          cleanup();
          resolve({ connect_id: asText });
          return;
        }

        // Try parsing as protocol binary frame
        let frame;
        try { frame = parseFrame(buf); } catch (_) {}
        if (!frame) {
          console.log('[volc-client] stage=connection unparseable, raw hex:', buf.slice(0, 30).toString('hex'));
          return;
        }
        if (frame.header.messageType === MessageType.FULL_SERVER_RESPONSE &&
            frame.event === EventId.START_CONNECTION) {
          cleanup();
          console.log('[volc-client] stage=connection confirmed');
          resolve(frame.payload);
        } else if (frame.header.messageType === MessageType.FULL_SERVER_RESPONSE &&
            frame.event === 50) {
          // Server sends event 50 for ConnectionStarted
          cleanup();
          console.log('[volc-client] stage=connection confirmed (event 50)');
          resolve(frame.payload);
        } else if (frame.header.messageType === MessageType.ERROR) {
          cleanup();
          console.log('[volc-client] stage=connection error:', JSON.stringify(frame.payload));
          reject(new Error(`Connection error: ${JSON.stringify(frame.payload)}`));
        }
      };

      this.ws.on('message', handler);

      const frame = buildTextFrame(EventId.START_CONNECTION, payload, { connectId: this.connectId });
      console.log('[volc-client] stage=sending StartConnection frame, size=' + frame.length);
      this.ws.send(frame);

      timeoutHandle = setTimeout(() => {
        if (settled) return;
        cleanup();
        console.log('[volc-client] stage=connection TIMEOUT (10s)');
        reject(new Error('Connection timeout'));
      }, 10000);
    });
  }

  _handleMessage(data, isBinary) {
    try {
      // Text message from server (JSON event or UUID)
      if (!isBinary) {
        const text = data.toString().trim();
        console.log('[volc-client] stage=text msg:', text.substring(0, 200));
        // Try to forward as a frame with a text payload
        const fakeFrame = {
          header: { messageType: 0x90, flags: 0, serialization: 0x10, compression: 0 },
          event: null,
          payload: (() => { try { return JSON.parse(text); } catch(_) { return { text }; } })(),
          payloadRaw: Buffer.from(text),
        };
        if (this._sessionHandler && !this.sessionStarted) {
          this._sessionHandler(fakeFrame);
          return;
        }
        this.onMessage?.(fakeFrame);
        return;
      }

      // Binary frame = parse protocol
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const frame = parseFrame(buf);
      if (!frame) {
        console.log('[volc-client] stage=parseFrame FAILED, raw bytes:', buf.slice(0, 20).toString('hex'));
        this.onError?.(new Error('Failed to parse frame'));
        return;
      }

      console.log('[volc-client] stage=frame msgType=' + frame.header.messageType.toString(16) +
        ' event=' + frame.event +
        ' flags=' + frame.header.flags.toString(16) +
        ' id=' + (frame.sessionId || frame.connectId || 'none') +
        ' payloadSize=' + (frame.payloadRaw ? frame.payloadRaw.length : 0) +
        ' payload=' + (frame.payloadRaw ? frame.payloadRaw.slice(0, 60).toString('utf-8').replace(/\n/g, '\\n') : ''));

      // Log ERROR frames in full
      if (frame.header.messageType === MessageType.ERROR) {
        const errText = frame.payloadRaw ? frame.payloadRaw.toString('utf-8') : '';
        console.log('[volc-client] stage=ERROR frame code=' + frame.code + ' body=' + errText);
      }

      // If we're waiting for session confirmation, route there
      if (this._sessionHandler && !this.sessionStarted) {
        this._sessionHandler(frame);
        return;
      }

      // Forward parsed frame to consumer
      this.onMessage?.(frame);
    } catch (err) {
      console.log('[volc-client] stage=handleMessage error:', err.message);
      this.onError?.(err);
    }
  }
}

module.exports = VolcengineClient;
