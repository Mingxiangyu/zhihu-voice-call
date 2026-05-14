const PROTOCOL_VERSION = 0x11; // v1 + header size 4

const MessageType = {
  FULL_CLIENT_REQUEST: 0x10,
  FULL_SERVER_RESPONSE: 0x90,
  AUDIO_ONLY_REQUEST: 0x20,
  AUDIO_ONLY_RESPONSE: 0xB0,
  ERROR: 0xF0,
};

// Flags low nibble layout (per 火山 RealtimeAPI 协议):
//   bits 0-1: sequence type (0=none, 1=positive, 2=last no-seq, 3=last neg-seq)
//   bit 2:    HAS_EVENT
//   0x0F:     ERROR sentinel
const Flags = {
  NO_SEQUENCE: 0x00,
  POSITIVE_SEQUENCE: 0x01,
  LAST_NO_SEQUENCE: 0x02,
  LAST_NEGATIVE_SEQUENCE: 0x03,
  HAS_EVENT: 0x04,
  ERROR: 0x0F,
};

const Serialization = {
  RAW: 0x00,
  JSON: 0x10,
};

const Compression = {
  NONE: 0x00,
  GZIP: 0x01,
};

// Client → Server event IDs
const EventId = {
  START_CONNECTION: 1,
  FINISH_CONNECTION: 2,
  START_SESSION: 100,
  FINISH_SESSION: 102,
  TASK_REQUEST: 200,
  UPDATE_CONFIG: 201,
  // 主动 TTS 开场白（推断值；联调失败可切 ZHIHU_OPENING_MODE=system_role 走兜底）
  SAY_HELLO: 300,
};

// Server → Client event IDs
const ServerEventId = {
  CONNECTION_STARTED: 50,
  CONNECTION_FAILED: 51,
  SESSION_STARTED: 150,
  SESSION_FINISHED: 152,
  SESSION_FAILED: 153,
  ASR_INFO: 450,
  ASR_RESPONSE: 451,
  ASR_ENDED: 459,
  TTS_SENTENCE_START: 350,
  TTS_RESPONSE: 352,
  TTS_ENDED: 359,
  CHAT_RESPONSE: 550,
  CHAT_ENDED: 559,
};

// 由事件 ID 判断该帧带 connect_id 还是 session_id（不通过 flag 控制）
const CONNECT_EVENTS = new Set([
  EventId.START_CONNECTION,         // 1
  EventId.FINISH_CONNECTION,        // 2
  ServerEventId.CONNECTION_STARTED, // 50
  ServerEventId.CONNECTION_FAILED,  // 51
]);

function isConnectEvent(event) {
  return CONNECT_EVENTS.has(event);
}

function isSessionEvent(event) {
  return typeof event === 'number' && event >= 100;
}

function encodeHeader(msgType, flags, serialization, compression) {
  const buf = Buffer.alloc(4);
  buf[0] = PROTOCOL_VERSION;
  buf[1] = (msgType & 0xF0) | (flags & 0x0F);
  buf[2] = (serialization & 0xF0) | (compression & 0x0F);
  buf[3] = 0x00;
  return buf;
}

function decodeHeader(buf) {
  if (buf.length < 4) return null;
  return {
    version: (buf[0] & 0xF0) >> 4,
    headerSize: buf[0] & 0x0F,
    messageType: buf[1] & 0xF0,
    flags: buf[1] & 0x0F,
    serialization: buf[2] & 0xF0,
    compression: buf[2] & 0x0F,
  };
}

function pushIdField(parts, id) {
  const idBuf = Buffer.from(id || '', 'utf-8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(idBuf.length);
  parts.push(lenBuf);
  parts.push(idBuf);
}

// Build a JSON event frame.
//   event:   numeric event id
//   payload: object to JSON-encode
//   ids:     { sessionId? } — only session events (event >= 100) carry an ID at the
//            protocol layer; connect-level events keep connect_id inside the JSON payload only.
function buildTextFrame(event, payload, ids = {}) {
  const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf-8');
  const flags = Flags.HAS_EVENT;

  const header = encodeHeader(MessageType.FULL_CLIENT_REQUEST, flags, Serialization.JSON, Compression.NONE);
  const parts = [header];

  const eventBuf = Buffer.alloc(4);
  eventBuf.writeUInt32BE(event);
  parts.push(eventBuf);

  if (isSessionEvent(event)) {
    pushIdField(parts, ids.sessionId);
  }

  const payloadLen = Buffer.alloc(4);
  payloadLen.writeUInt32BE(payloadBuf.length);
  parts.push(payloadLen);
  parts.push(payloadBuf);

  return Buffer.concat(parts);
}

// Build an audio frame. Always TASK_REQUEST(200) under a session.
//   audioData:  raw PCM bytes
//   sequence:   positive 32-bit int (becomes -sequence when isLast — 服务端按已发帧累计校验)
//   isLast:     true = LAST_NEGATIVE_SEQUENCE，写入 -sequence
//   sessionId:  UUID string
function buildAudioFrame(audioData, sequence, isLast, sessionId) {
  const flags = (isLast ? Flags.LAST_NEGATIVE_SEQUENCE : Flags.POSITIVE_SEQUENCE) | Flags.HAS_EVENT;
  const header = encodeHeader(MessageType.AUDIO_ONLY_REQUEST, flags, Serialization.RAW, Compression.NONE);
  const parts = [header];

  const seqBuf = Buffer.alloc(4);
  if (isLast) {
    seqBuf.writeInt32BE(-sequence);
  } else {
    seqBuf.writeUInt32BE(sequence);
  }
  parts.push(seqBuf);

  const eventBuf = Buffer.alloc(4);
  eventBuf.writeUInt32BE(EventId.TASK_REQUEST);
  parts.push(eventBuf);

  // TASK_REQUEST is a session event → session_id required
  pushIdField(parts, sessionId);

  const payloadLen = Buffer.alloc(4);
  payloadLen.writeUInt32BE(audioData.length);
  parts.push(payloadLen);
  parts.push(audioData);

  return Buffer.concat(parts);
}

// Parse one frame from a buffer.
// Returns: { header, code?, sequence?, event?, connectId?, sessionId?, payload, payloadRaw }
function parseFrame(buf) {
  if (buf.length < 4) return null;

  const header = decodeHeader(buf);
  if (!header) return null;

  let pos = 4;
  const out = { header };

  // ERROR frames have a fixed shape: [header][code(4)][payload_size(4)][payload(N)].
  // Their flag low nibble is the 0x0F sentinel — do NOT interpret bits as sequence/event.
  if (header.messageType === MessageType.ERROR) {
    if (pos + 4 > buf.length) return null;
    out.code = buf.readUInt32BE(pos);
    pos += 4;

    if (pos + 4 > buf.length) return null;
    const payloadLen = buf.readUInt32BE(pos);
    pos += 4;
    if (pos + payloadLen > buf.length) return null;
    out.payloadRaw = buf.subarray(pos, pos + payloadLen);
    try {
      out.payload = JSON.parse(out.payloadRaw.toString('utf-8'));
    } catch (_) {
      out.payload = out.payloadRaw.toString('utf-8');
    }
    return out;
  }

  // Sequence: present only for positive (0x01) or last-negative (0x03) flag values.
  const seqType = header.flags & 0x03;
  if (seqType === Flags.POSITIVE_SEQUENCE || seqType === Flags.LAST_NEGATIVE_SEQUENCE) {
    if (pos + 4 > buf.length) return null;
    out.sequence = buf.readInt32BE(pos);
    pos += 4;
  }

  // Event + (session_id field for session-level events only)
  if (header.flags & Flags.HAS_EVENT) {
    if (pos + 4 > buf.length) return null;
    out.event = buf.readUInt32BE(pos);
    pos += 4;

    if (isSessionEvent(out.event)) {
      if (pos + 4 > buf.length) return null;
      const len = buf.readUInt32BE(pos);
      pos += 4;
      if (pos + len > buf.length) return null;
      out.sessionId = buf.subarray(pos, pos + len).toString('utf-8');
      pos += len;
    }
  }

  // Payload
  if (pos + 4 > buf.length) return null;
  const payloadLen = buf.readUInt32BE(pos);
  pos += 4;

  if (pos + payloadLen > buf.length) return null;
  const payloadRaw = buf.subarray(pos, pos + payloadLen);
  out.payloadRaw = payloadRaw;

  if (header.serialization === Serialization.JSON) {
    try {
      out.payload = JSON.parse(payloadRaw.toString('utf-8'));
    } catch (_) {
      out.payload = payloadRaw.toString('utf-8');
    }
  } else {
    out.payload = payloadRaw;
  }

  return out;
}

module.exports = {
  MessageType,
  Flags,
  Serialization,
  Compression,
  EventId,
  ServerEventId,
  CONNECT_EVENTS,
  isConnectEvent,
  isSessionEvent,
  encodeHeader,
  decodeHeader,
  buildTextFrame,
  buildAudioFrame,
  parseFrame,
};
