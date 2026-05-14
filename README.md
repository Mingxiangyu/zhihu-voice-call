# 刘看山语音通话

基于火山引擎 RealtimeAPI 的实时语音对话 Demo。用户通过知乎 OAuth 登录后，AI（刘看山）会主动用用户昵称打招呼，并朗读用户关注动态中最近 3 条回答类内容，随后进入自由对话。

## 功能

- **知乎 OAuth 2.0 登录**：授权码模式，cookie + 服务端 session 存登录态
- **AI 主动开口**：接通后 1~2 秒内自动说「你好 {昵称}」+ 关注动态朗读
- **实时语音对话**：浏览器采集 16kHz PCM → 火山 ASR → Chat → TTS → 浏览器播放 24kHz Float32 PCM
- **双模式开场白**：
  - `say_hello`：走火山 SayHello 事件（event=300，推断值）
  - `system_role`：把开场白硬编码进 system role 兜底

## 技术栈

- Node 18+ / Express 5 / ws / dotenv / uuid
- 火山引擎实时对话 v3（`wss://openspeech.bytedance.com/api/v3/realtime/dialogue`）
- 知乎 OpenAPI（`https://openapi.zhihu.com`）
- 前端原生 JS + Web Audio API + WebSocket

## 目录结构

```
src/
  server.js              # Express 入口：HTTP 路由 + WS 中转
  protocol.js            # 火山二进制协议编解码
  volcengine-client.js   # 火山 WS 客户端（连接/会话/音频/SayHello）
  session-store.js       # 进程内 session 管理
  cookies.js             # 极简 cookie 读写
  zhihu/
    auth.js              # OAuth 路由：/oauth/login、/oauth/callback、/api/me、/api/logout
    api.js               # 知乎 API 封装
    prompt.js            # 开场白 + systemRole 拼接
public/
  index.html             # 通话页面
  script.js              # 前端逻辑（登录态、音频采集、TTS 播放）
  style.css
  img/
    liukanshan.png       # AI 头像
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env`，并填写以下必填项：

```bash
# 火山引擎（语音对话）
VOLC_APP_ID=你的火山应用ID
VOLC_APP_KEY=你的火山应用密钥
VOLC_ACCESS_KEY=你的火山访问密钥

# 知乎开放平台（OAuth + 用户信息）
ZHIHU_APP_ID=你的知乎应用ID
ZHIHU_APP_KEY=你的知乎应用密钥
ZHIHU_REDIRECT_URI=https://你的域名/oauth/callback

# 可选
PORT=4001
MODEL=1.2.1.1
TTS_VOICE_TYPE=
ZHIHU_OPENING_MODE=say_hello   # say_hello | system_role
```

> **安全提醒**：`.env` 已加入 `.gitignore`，**永远不要提交到仓库**。如果密钥意外泄漏，立即去对应控制台轮换。

### 3. 配置知乎回调地址

在[知乎开放平台](https://open.zhihu.com) → 应用管理 → 回调地址，填写与 `ZHIHU_REDIRECT_URI` **完全一致**的 URL，例如：

```
https://yourdomain.com/oauth/callback
```

### 4. 启动

开发模式（热重载）：
```bash
npm run dev
```

生产模式：
```bash
npm start
```

浏览器访问 `http://localhost:4001/`（或你配置的线上地址）。

## OAuth 流程

1. 用户点击「登录知乎」→ 后端生成 state → 302 跳 `https://openapi.zhihu.com/authorize`
2. 用户在知乎授权页同意 → 携带 `code` 跳回 `ZHIHU_REDIRECT_URI`
3. 后端用 `code` 换 `access_token` → 调 `/user` 获取用户信息 → 写 session + cookie
4. 前端展示用户头像/昵称，通话按钮可用

## 环境变量说明

| 变量 | 必填 | 说明 |
|---|---|---|
| `VOLC_APP_ID` | 是 | 火山引擎语音应用 ID |
| `VOLC_APP_KEY` | 是 | 火山引擎应用密钥 |
| `VOLC_ACCESS_KEY` | 是 | 火山引擎访问密钥 |
| `ZHIHU_APP_ID` | 是 | 知乎开放平台应用 ID |
| `ZHIHU_APP_KEY` | 是 | 知乎开放平台应用密钥 |
| `ZHIHU_REDIRECT_URI` | 是 | OAuth 回调地址，必须与知乎控制台填写一致 |
| `ZHIHU_AUTHORIZE_URL` | 否 | 授权页地址，默认 `https://openapi.zhihu.com/authorize` |
| `ZHIHU_API_BASE` | 否 | API 基地址，默认 `https://openapi.zhihu.com` |
| `ZHIHU_OPENING_MODE` | 否 | 开场白模式：`say_hello`（默认）或 `system_role` |
| `SESSION_COOKIE_NAME` | 否 | Cookie 名，默认 `sid` |
| `SESSION_TTL_SECONDS` | 否 | Cookie 有效期，默认 86400 秒 |
| `PORT` | 否 | 服务端口，默认 3000 |
| `MODEL` | 否 | 火山模型版本，默认 `1.2.1.1` |
| `TTS_VOICE_TYPE` | 否 | TTS 音色，留空使用模型默认 |

## 部署注意事项

- **HTTPS**：线上部署请使用 HTTPS，否则浏览器可能拒绝麦克风权限。
- **Cookie Secure**：如果服务跑在 HTTPS 下，建议把 `src/cookies.js` 里的 `secure: false` 改成根据环境动态判断（`req.headers['x-forwarded-proto'] === 'https'`）。
- **Session 持久化**：当前 session 存在进程内存，重启失效。多实例或需要持久化时，换成 Redis / SQLite / 文件存储。
- **进程管理**：生产环境建议用 `pm2` 或 `systemd` 托管 Node 进程。

## 安全

- 所有密钥、token、密码不进代码、不进 commit、不进日志。
- 服务端日志中敏感字段最多打印前 8 位 + 长度。
- 用户 phone_no / email 不落日志、不外传给前端。

## License

ISC
