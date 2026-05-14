const WS_URL = `ws://${location.host}`;

const STATUS_IDLE = '点击下方按钮开始通话';
const STATUS_LOGIN_REQUIRED = '请先登录知乎';
const STATUS_CONNECTING = '连接中...';
const STATUS_TALKING = '通话中';
const STATUS_STOPPING = '挂断中...';

// DOM
const avatar = document.getElementById('avatar');
const ring = document.getElementById('ring');
const statusEl = document.getElementById('status');
const callBtn = document.getElementById('callBtn');
const callIcon = document.getElementById('callIcon');
const timerEl = document.getElementById('timer');
const transcriptEl = document.getElementById('transcript');
const authBar = document.getElementById('authBar');

// State
let ws = null;
let audioContext = null;
let mediaStream = null;
let processor = null;
let isCalling = false;
let isCleaningUp = false;
let timerInterval = null;
let startTime = null;
let audioQueue = [];
let isPlaying = false;
let hangUpTimeout = null;
let currentUser = null;     // { uid, fullname, avatar_path, ... }
let isLoggedIn = false;

// Hover effect: ring animation on avatar
avatar.addEventListener('mouseenter', () => {
  if (!isCalling && isLoggedIn) {
    ring.classList.add('active');
  }
});
avatar.addEventListener('mouseleave', () => {
  if (!isCalling) {
    ring.classList.remove('active');
  }
});

// Call button
callBtn.addEventListener('click', async () => {
  if (!isLoggedIn) return;
  if (isCalling) {
    await hangUp();
  } else {
    await startCall();
  }
});

// ---- Auth ----

async function checkAuth() {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (res.status === 401) {
      renderLoggedOut();
      return;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    currentUser = data.user || null;
    isLoggedIn = !!currentUser;
    if (isLoggedIn) renderLoggedIn(currentUser);
    else renderLoggedOut();
  } catch (err) {
    console.error('[auth] checkAuth failed:', err);
    renderLoggedOut();
  }
}

function renderLoggedOut() {
  isLoggedIn = false;
  currentUser = null;
  authBar.innerHTML = '';
  const btn = document.createElement('button');
  btn.className = 'login-btn';
  btn.textContent = '登录知乎';
  btn.addEventListener('click', () => { window.location.href = '/oauth/login'; });
  authBar.appendChild(btn);

  callBtn.disabled = true;
  setStatus('login_required');
}

function renderLoggedIn(user) {
  isLoggedIn = true;
  authBar.innerHTML = '';

  const chip = document.createElement('div');
  chip.className = 'user-chip';

  const img = document.createElement('img');
  img.className = 'user-avatar';
  img.alt = user.fullname || '用户头像';
  img.src = user.avatar_path || '';
  img.onerror = () => { img.src = 'img/liukanshan.png'; };
  chip.appendChild(img);

  const name = document.createElement('span');
  name.className = 'user-name';
  name.textContent = user.fullname || '匿名用户';
  chip.appendChild(name);

  authBar.appendChild(chip);

  const logout = document.createElement('button');
  logout.className = 'logout-btn';
  logout.textContent = '退出';
  logout.addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    if (isCalling) await hangUp();
    renderLoggedOut();
  });
  authBar.appendChild(logout);

  callBtn.disabled = false;
  if (!isCalling) setStatus('idle');
}

// ---- Call flow ----

async function startCall() {
  console.log('[browser] startCall begin');
  setStatus('connecting');

  try {
    // 1. Get mic
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 16000,
      },
    });
    console.log('[browser] mic granted');

    // 2. Connect WebSocket
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('[browser] ws.onopen, sending start');
      // systemRole / botName 全部由后端基于 session 拼，前端不再传
      ws.send(JSON.stringify({ type: 'start' }));
    };

    ws.onmessage = (event) => {
      handleWsMessage(event);
    };

    ws.onclose = (evt) => {
      console.log('[browser] ws.onclose code=' + evt.code);
      if (isCalling || isCleaningUp) cleanupCall();
    };

    ws.onerror = () => {
      console.log('[browser] ws.onerror');
      setStatus('连接失败，请重试');
      cleanupCall();
    };
  } catch (err) {
    console.log('[browser] startCall error:', err.message);
    if (err.name === 'NotAllowedError' || err.name === 'NotFoundError') {
      setStatus('需要麦克风权限才能通话');
    } else {
      setStatus('连接失败: ' + err.message);
    }
    cleanupCall();
  }
}

function handleWsMessage(event) {
  // Binary = TTS audio data
  if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
    if (event.data instanceof Blob) {
      const reader = new FileReader();
      reader.onload = () => {
        audioQueue.push(reader.result);
        if (!isPlaying) playNextAudio();
      };
      reader.readAsArrayBuffer(event.data);
    } else {
      audioQueue.push(event.data);
      if (!isPlaying) playNextAudio();
    }
    return;
  }

  // Text = JSON control messages
  try {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'ready':
        onSessionReady();
        break;
      case 'asr_info':
        ring.classList.add('active');
        ring.classList.remove('speaking');
        break;
      case 'asr':
        showTranscript('user', msg.text || '');
        break;
      case 'chat':
        showTranscript('bot', msg.text || '');
        ring.classList.remove('active');
        ring.classList.add('speaking');
        break;
      case 'chat_ended':
        break;
      case 'tts':
        break;
      case 'error':
        setStatus('错误: ' + msg.message);
        callBtn.disabled = !isLoggedIn;
        if (ws) { ws.close(); ws = null; }
        // 登录失效场景：刷新 auth
        if (msg.message && /登录/.test(msg.message)) {
          checkAuth();
        }
        break;
      case 'stopped':
        setStatus('通话已结束');
        break;
      case 'event':
        break;
    }
  } catch (err) {
    console.error('Parse error:', err);
  }
}

function onSessionReady() {
  isCalling = true;
  setStatus('talking');
  callBtn.disabled = false;
  callBtn.classList.add('in-call');
  ring.classList.add('active');
  transcriptEl.classList.add('visible');

  startTime = Date.now();
  timerInterval = setInterval(updateTimer, 1000);

  startAudioCapture();
}

function startAudioCapture() {
  if (!mediaStream) return;

  audioContext = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: 16000,
  });

  const source = audioContext.createMediaStreamSource(mediaStream);
  const scriptNode = audioContext.createScriptProcessor(1024, 1, 1);

  scriptNode.onaudioprocess = (event) => {
    if (!isCalling || !ws || ws.readyState !== WebSocket.OPEN) return;

    const inputData = event.inputBuffer.getChannelData(0);
    const pcmData = new Int16Array(inputData.length);
    for (let i = 0; i < inputData.length; i++) {
      const s = Math.max(-1, Math.min(1, inputData[i]));
      pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    ws.send(pcmData.buffer);
  };

  source.connect(scriptNode);
  scriptNode.connect(audioContext.destination);

  processor = { source, scriptNode };
}

function playNextAudio() {
  if (audioQueue.length === 0) {
    isPlaying = false;
    return;
  }

  isPlaying = true;
  const audioData = audioQueue.shift();

  try {
    // 火山 TTS PCM 是 float32 LE
    const float32 = new Float32Array(audioData);
    if (!audioContext) return;
    const buffer = audioContext.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.onended = () => { playNextAudio(); };
    source.start();
  } catch (err) {
    console.error('Playback error:', err);
    playNextAudio();
  }
}

async function hangUp() {
  setStatus('stopping');

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'stop' }));
  }

  if (hangUpTimeout) clearTimeout(hangUpTimeout);
  hangUpTimeout = setTimeout(() => {
    cleanupCall();
    setStatus('通话已结束');
    setTimeout(() => {
      if (!isCalling) setStatus(isLoggedIn ? 'idle' : 'login_required');
    }, 2000);
  }, 3000);
}

function cleanupCall() {
  if (isCleaningUp) return;
  isCleaningUp = true;
  isCalling = false;

  callBtn.classList.remove('in-call');
  ring.classList.remove('active', 'speaking');
  callBtn.disabled = !isLoggedIn;

  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  startTime = null;
  timerEl.textContent = '';

  if (processor) {
    try {
      processor.source.disconnect();
      processor.scriptNode.disconnect();
    } catch (_) {}
    processor = null;
  }

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }

  if (ws) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    ws = null;
  }

  audioQueue = [];
  isPlaying = false;

  if (hangUpTimeout) {
    clearTimeout(hangUpTimeout);
    hangUpTimeout = null;
  }

  isCleaningUp = false;
}

// ---- UI helpers ----

function setStatus(state) {
  switch (state) {
    case 'idle':
      statusEl.textContent = currentUser?.fullname
        ? `你好 ${currentUser.fullname}，${STATUS_IDLE}`
        : STATUS_IDLE;
      break;
    case 'login_required':
      statusEl.textContent = STATUS_LOGIN_REQUIRED;
      break;
    case 'connecting':
      statusEl.textContent = STATUS_CONNECTING;
      callBtn.disabled = true;
      setTimeout(() => { callBtn.disabled = !isLoggedIn; }, 3000);
      break;
    case 'talking':
      statusEl.textContent = STATUS_TALKING;
      break;
    case 'stopping':
      statusEl.textContent = STATUS_STOPPING;
      break;
    default:
      statusEl.textContent = state;
  }
}

function updateTimer() {
  if (!startTime) return;
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const min = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const sec = String(elapsed % 60).padStart(2, '0');
  timerEl.textContent = `${min}:${sec}`;
}

function showTranscript(role, text) {
  if (!text || text.trim() === '') return;

  const className = role === 'user' ? 'user-text' : 'bot-text';
  const label = role === 'user'
    ? (currentUser?.fullname || '你')
    : '刘看山';

  const lastChild = transcriptEl.lastElementChild;
  if (lastChild && lastChild.classList.contains(className)) {
    // user 的 ASR 每帧累计文本，覆盖；bot 的 chat 是分片，追加
    const accumulated = role === 'bot'
      ? (lastChild.dataset.text || '') + text
      : text;
    lastChild.dataset.text = accumulated;
    lastChild.textContent = `${label}: ${accumulated}`;
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
    return;
  }

  const div = document.createElement('div');
  div.className = className;
  div.dataset.label = label;
  div.dataset.text = text;
  div.textContent = `${label}: ${text}`;
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// Init
checkAuth();
