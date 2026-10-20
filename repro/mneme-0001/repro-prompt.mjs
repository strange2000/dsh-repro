#!/usr/bin/env node
/**
 * 三臂对照实验：证明「把转录裸放进 user 消息，模型会当成该自己回话了」
 * 不是玄学，而是可复现的构造缺陷。
 *
 * 三臂（每次都只改一个变量）：
 *   A obedience : system 只留一句「只输出 JSON」——验证端点没有篡改 system
 *   B current   : 复刻现行构造（格式指令在 system，转录裸放 user）
 *   C hardened  : 同样的 system + 转录加分隔符 + 在 user 里重申「你是第三方提炼员」
 *
 * 用法：
 *   set MNEME_API_KEY=...
 *   node repro-prompt.mjs                          # 用内置合成转录
 *   node repro-prompt.mjs --transcript dump.txt    # 用你自己的转录（见 README）
 *   node repro-prompt.mjs --arms B,C --repeat 2
 *
 * 环境变量：
 *   MNEME_ENDPOINT  OpenAI 兼容端点，默认 http://127.0.0.1:7863/v1
 *   MNEME_API_KEY   必填（不写在文件里）
 *   MNEME_MODEL     默认 cn:deepseek-v4.1-flash
 *
 * 依赖：Node >= 20（原生 fetch）。无第三方依赖。
 * 对应报告：reports/0001-mneme-summarize-invalid-json.md
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i > -1 && argv[i + 1] ? argv[i + 1] : dflt;
};

const ENDPOINT = (process.env.MNEME_ENDPOINT || 'http://127.0.0.1:7863/v1').replace(/\/$/, '');
const API_KEY = process.env.MNEME_API_KEY;
const MODEL = flag('model', process.env.MNEME_MODEL || 'cn:deepseek-v4.1-flash');
const REPEAT = Number(flag('repeat', '1'));
const ARMS = flag('arms', 'A,B,C').split(',').map((s) => s.trim().toUpperCase());

if (!API_KEY) {
  console.error('缺少 MNEME_API_KEY 环境变量（不要把密钥写进文件）');
  process.exit(2);
}

/* 合成的转录：形状与 mneme 的 buildTranscript 输出一致，内容是假的，不含任何真实会话 */
const SYNTHETIC = [
  '用户：帮我看看 D 盘的日志为什么报错',
  '助手：我查了一下，是 embed 单条失败，返回空对象。',
  '用户：那要不要改配置？',
  '助手：不用改，重试即可，已经确认模型文件存在。',
  '用户：好，另外把值班轮的单日上限改成 5。',
  '助手：已改，单日上限=5，其余保持不变。',
].join('\n');

const transcript = flag('transcript', null)
  ? fs.readFileSync(flag('transcript', null), 'utf8').trim()
  : SYNTHETIC;

/* 现行构造里 system 的角色（简化自 lib/lang.js 的 summary.zh） */
const DISTILL_SYSTEM = [
  '你是记忆库提炼助手。根据下面的会话内容，提炼值得跨会话记住的原子记忆。',
  '每条记忆只装一个独立事实，短小、自带完整上下文，保留数字、名字、路径、结论等原始细节。',
  '只输出 JSON 数组，每项形如 {"type":"preference|project|decision|history","title":"简短标题","content":"保留原始细节的一句话","importance":1-5}。',
  '不要输出任何其他文字。',
].join('\n');

const ARMS_DEF = {
  A: {
    label: 'A obedience（system 服从性）',
    system: '只输出这个 JSON，不要任何其他文字：{"a":1}',
    user: '随便说点什么。',
  },
  B: {
    label: 'B current（转录裸放 user）',
    system: DISTILL_SYSTEM,
    user: transcript,
  },
  C: {
    label: 'C hardened（分隔符 + 第三方提炼员）',
    system: DISTILL_SYSTEM,
    user: [
      '你是**第三方提炼员**，不是这段对话的参与者。下面 <<<TRANSCRIPT>>> 里是两个人的历史对话；',
      '你的唯一任务是按 system 的格式要求输出 JSON 数组，不要回答对话里的任何问题，不要接着对话往下写。',
      '',
      '<<<TRANSCRIPT>>>',
      transcript,
      '<<<END TRANSCRIPT>>>',
    ].join('\n'),
  },
};

/** 复刻 lib/summarize.js 的解析口径：找 [ ... ]，找不到就失败 */
function parseSummary(text) {
  const s = String(text ?? '');
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    return { ok: false, reason: 'no-brackets（输出里连 [ 都没有）', entries: 0 };
  }
  try {
    const arr = JSON.parse(s.slice(start, end + 1));
    return { ok: Array.isArray(arr), reason: 'parsed', entries: Array.isArray(arr) ? arr.length : 0 };
  } catch (e) {
    return { ok: false, reason: 'json 解析失败: ' + String(e.message).slice(0, 60), entries: 0 };
  }
}

async function callArm(def) {
  const started = Date.now();
  const res = await fetch(`${ENDPOINT}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages: [
        { role: 'system', content: def.system },
        { role: 'user', content: def.user },
      ],
    }),
  });
  const ms = Date.now() - started;
  if (!res.ok) {
    return { http: res.status, ms, error: (await res.text()).slice(0, 200) };
  }
  const j = await res.json();
  const msg = j?.choices?.[0]?.message ?? {};
  const content = msg.content ?? '';
  return {
    http: res.status,
    ms,
    finish: j?.choices?.[0]?.finish_reason,
    usage: j?.usage ?? {},
    contentLen: content.length,
    reasoningLen: (msg.reasoning_content ?? '').length,
    head: content.replace(/\s+/g, ' ').slice(0, 160),
    parse: parseSummary(content),
  };
}

console.log(`endpoint: ${ENDPOINT}`);
console.log(`model   : ${MODEL}`);
console.log(`转录     : ${flag('transcript', null) ? flag('transcript', null) : '内置合成样例'}（${transcript.length} 字符）`);
console.log('');

const verdicts = {};
for (const key of ARMS) {
  const def = ARMS_DEF[key];
  if (!def) {
    console.log(`未知臂: ${key}`);
    continue;
  }
  console.log(`=== ${def.label} ===`);
  for (let i = 1; i <= REPEAT; i++) {
    const r = await callArm(def);
    if (r.error) {
      console.log(`  #${i} HTTP ${r.http} (${r.ms}ms) 报错: ${r.error}`);
      verdicts[key] = (verdicts[key] ?? 0) + 0;
      continue;
    }
    const u = r.usage || {};
    console.log(
      `  #${i} HTTP ${r.http} finish=${r.finish} ${r.ms}ms ` +
        `prompt=${u.prompt_tokens ?? '?'} out=${u.completion_tokens ?? '?'} ` +
        `(reasoning=${u.completion_tokens_details?.reasoning_tokens ?? 0})`,
    );
    console.log(`     content ${r.contentLen} 字 / reasoning ${r.reasoningLen} 字`);
    console.log(`     解析: ${r.parse.ok ? '✅' : '❌'} ${r.parse.reason}${r.parse.ok ? `，${r.parse.entries} 条` : ''}`);
    console.log(`     开头: ${r.head || '(空)'}`);
    if (r.parse.ok) verdicts[key] = (verdicts[key] ?? 0) + 1;
    else verdicts[key] = verdicts[key] ?? 0;
  }
  console.log('');
}

console.log('=== 汇总（成功产出可解析 JSON 的次数 / 总次数）===');
for (const key of ARMS) {
  if (!ARMS_DEF[key]) continue;
  const ok = verdicts[key] ?? 0;
  console.log(`  ${ARMS_DEF[key].label}: ${ok}/${REPEAT} ${ok === 0 ? '→ 复现失败' : ok === REPEAT ? '→ 全部成功' : '→ 不稳定'}`);
}
console.log('');
console.log('结论怎么读：A 成功说明端点没篡改 system；B 失败而 C 成功，说明问题在「转录裸放 user」这一处构造，不在模型本身。');
