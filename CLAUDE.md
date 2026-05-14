# 项目规范（CLAUDE.md）

## 用途
基于火山引擎 RealtimeAPI 实现"知乎用户语音通话"：浏览器拿麦克风 → Node WS 中转 → 火山 ASR/Chat/TTS 双向流。叠加知乎 OAuth 后，AI 开场会主动用昵称打招呼并朗读用户关注动态中的最新回答。

## 技术栈
- Node 18+ / Express 5 / ws / dotenv / uuid
- 火山引擎实时对话 v3（`wss://openspeech.bytedance.com/api/v3/realtime/dialogue`）
- 知乎 OpenAPI（`https://openapi.zhihu.com`），OAuth 2.0 授权码模式
- 前端原生 JS + Web Audio + WebSocket

## 目录约定

```
src/
  server.js              入口：HTTP 路由 + WS 中转
  protocol.js            火山二进制协议编解码（事件 ID、帧格式）
  volcengine-client.js   火山 WS 客户端（连接/会话/音频/SayHello）
  session-store.js       浏览器登录态：sid -> {accessToken, user, ...} 进程内 Map
  zhihu/
    auth.js              OAuth 路由：/oauth/login、/oauth/callback、/api/me、/api/logout
    api.js               知乎 API 调用封装：exchangeToken / getUser / getUserMoments
    prompt.js            开场白文本拼接（昵称 + 最近 3 条回答类动态）
public/
  index.html
  script.js              通话前端：登录态判断、音频采集、TTS 播放
  style.css
```

约定：
- 新增第三方平台对接放 `src/{平台名}/`（如 `src/zhihu/`），不要把外部 API 调用散到 `server.js`。
- 文件名小写 + 中划线；类用大驼峰；常量全大写下划线。
- 配置一律从 `.env` 读，**不要写死在代码**。

## 启动 / 验证

```bash
npm install        # 首次或更新依赖
npm run dev        # node --watch，开发用
npm start          # 生产用
```

改完代码必须实际跑一遍：
1. 浏览器开 `http://localhost:4001/` 看登录态是否正确
2. 点登录走 OAuth 全流程
3. 点通话，确认 AI 主动开口、朗读动态、能正常对话
4. 后端日志确认无 ERROR 帧

## 密钥与日志规则（红线）

- `.env`、`*.local` 永远不进 git；`.env.example` 只放占位
- 火山 / 知乎的 `app_key`、`access_token`、`refresh_token` 一律不打全量到日志，最多打前 8 位 + 长度
- 用户 phone_no / email 不要落日志
- 任何密钥泄漏到聊天 / 公开渠道，立即去对应控制台轮换

## 已知风险点

- 火山 `SayHello` event=300 是事件 ID 命名规律的合理推断，联调可能要调整；已准备 `system_role` 兜底
- 知乎 OAuth 不传 `scope`，phone/email 等敏感字段默认返回空字符串，业务不依赖
- session 进程内存储，重启失效（单用户场景可接受；多用户场景换持久化）
- 知乎所有错误响应 HTTP 都是 200，必须看 body 里的 `code` 字段判断
