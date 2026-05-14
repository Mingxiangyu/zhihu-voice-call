const MAX_EXCERPT_CHARS = 80;
const ACTION_ANSWERED = '回答了问题';

function stripHtml(s) {
  if (!s) return '';
  return String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function rtrimPunctuation(s) {
  return String(s || '').replace(/[。，、；：！？.,;:!?]+$/, '');
}

function truncate(s, max = MAX_EXCERPT_CHARS) {
  const t = stripHtml(s);
  if (t.length <= max) return t;
  return t.slice(0, max) + '…';
}

// 知乎 /user/moments 返回的单条 item 字段位置不稳，逐个兜底。
function pickAuthor(item) {
  return item?.actor?.fullname
      || item?.actor?.name
      || item?.target?.author?.fullname
      || '一位你关注的朋友';
}

function pickQuestionTitle(item) {
  return item?.target?.question?.title
      || item?.target?.title
      || item?.title
      || '一个问题';
}

function pickExcerpt(item) {
  return truncate(
    item?.target?.excerpt
    || item?.target?.excerpt_new
    || item?.target?.content
    || item?.excerpt
    || ''
  );
}

// 过滤出最近 3 条回答类动态
function pickAnsweredMoments(momentsData, limit = 3) {
  if (!Array.isArray(momentsData)) return [];
  return momentsData
    .filter((it) => it?.action_text === ACTION_ANSWERED)
    .slice(0, limit);
}

// 拼成给用户朗读的开场稿（明文，会经 TTS 念出来）
function buildHelloText(fullname, momentsData) {
  const name = fullname || '朋友';
  const answered = pickAnsweredMoments(momentsData, 3);

  if (answered.length === 0) {
    return `你好 ${name}，最近你关注的人没什么新回答，想聊点别的吗？`;
  }

  const lines = [`你好 ${name}，我帮你瞄了一眼最近的关注动态。`];
  for (const item of answered) {
    const author = pickAuthor(item);
    const title = pickQuestionTitle(item);
    const excerpt = rtrimPunctuation(pickExcerpt(item));
    if (excerpt) {
      lines.push(`${author} 回答了《${title}》，他说：${excerpt}。`);
    } else {
      lines.push(`${author} 回答了《${title}》。`);
    }
  }
  lines.push('要不要展开聊聊哪一条？');
  return lines.join('\n');
}

// 拼带用户信息的 system role（豆包对话用，不会念出来）
function buildSystemRole(fullname, helloText, mode) {
  const base = `你是刘看山，一只来自北极的白色北极狐，也是知乎的吉祥物。
你性格温和友善，充满好奇心，略带幽默感，回答简短自然、像朋友聊天。
当前正在和知乎用户「${fullname || '朋友'}」对话，请用第二人称「你」称呼对方，不要重复 ta 的名字太多次。
回答尽量短，必要时再展开。`;

  // 兜底模式：把开场白塞进 system role，强制 AI 一开口就念
  if (mode === 'system_role') {
    return base + `

【重要】会话开始后你必须立刻、原文、完整地说出下面这段话作为开场白，不要重新组织语言、不要省略：
"""
${helloText}
"""
说完这段开场白后，再等待用户提问。`;
  }
  return base;
}

module.exports = {
  buildHelloText,
  buildSystemRole,
  pickAnsweredMoments,
};
