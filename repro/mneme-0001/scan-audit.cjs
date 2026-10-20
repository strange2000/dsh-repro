#!/usr/bin/env node
/**
 * 只读取证：把 mneme 审计表里的「总结提炼失败」拉出来，并判断它到底是
 * 「20 次不同的偶发失败」还是「同一个窗口被确定性重试了 20 次」。
 *
 * 用法：
 *   node scan-audit.cjs                      # 默认读 E:/mneme/memory.db，看最近 7 天
 *   node scan-audit.cjs --days 1             # 只看最近 24h
 *   node scan-audit.cjs --db /path/memory.db
 *   node scan-audit.cjs --op summarize_compress
 *
 * 依赖：Node >= 22（内置 node:sqlite），不需要 npm install。
 * 安全：数据库以 readOnly 打开，脚本不会写入任何东西。
 *
 * 对应报告：reports/0001-mneme-summarize-invalid-json.md
 */
const { DatabaseSync } = require('node:sqlite');

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i > -1 && argv[i + 1] ? argv[i + 1] : dflt;
};

const DB = flag('db', process.env.MNEME_DB || 'E:/mneme/memory.db');
const DAYS = Number(flag('days', '7'));
const ONLY_OP = flag('op', null);

const since = new Date(Date.now() - DAYS * 864e5).toISOString();
const iso = (s) => (s || '').replace('T', ' ').replace(/\.\d+Z$/, 'Z');
const pad = (v, n) => String(v ?? '').padEnd(n).slice(0, n);
const padL = (v, n) => String(v ?? '').padStart(n).slice(0, n);

const db = new DatabaseSync(DB, { readOnly: true });

console.log(`库: ${DB}`);
console.log(`窗口: 最近 ${DAYS} 天（since ${since}）`);
console.log('');

/* ---------- 1. 各操作的成败分布 ---------- */
const dist = db
  .prepare(
    `SELECT operation_type AS op,
            status,
            COALESCE(NULLIF(error_message, ''), '(ok)') AS err,
            COUNT(*) AS n
       FROM llm_audit_logs
      WHERE timestamp >= ?${ONLY_OP ? ' AND operation_type = ?' : ''}
      GROUP BY 1, 2, 3
      ORDER BY 1, n DESC`,
  )
  .all(...(ONLY_OP ? [since, ONLY_OP] : [since]));

console.log('== 1. 各操作成败分布 ==');
console.log(pad('operation', 22) + pad('status', 8) + padL('n', 6) + '  error');
for (const r of dist) {
  console.log(pad(r.op, 22) + pad(r.status, 8) + padL(r.n, 6) + '  ' + r.err.slice(0, 60));
}
console.log('');

/* ---------- 2. 失败明细 ---------- */
const fails = db
  .prepare(
    `SELECT timestamp, operation_type AS op, model_id,
            input_tokens AS inp, output_tokens AS out, duration_ms AS ms,
            error_message AS err
       FROM llm_audit_logs
      WHERE timestamp >= ? AND error_message IS NOT NULL AND error_message <> ''
      ${ONLY_OP ? 'AND operation_type = ?' : ''}
      ORDER BY timestamp ASC`,
  )
  .all(...(ONLY_OP ? [since, ONLY_OP] : [since]));

console.log(`== 2. 失败明细（${fails.length} 条）==`);
if (!fails.length) {
  console.log('(无失败)');
} else {
  console.log(pad('time (UTC)', 21) + pad('operation', 20) + pad('model', 34) + padL('in', 7) + padL('out', 6) + padL('ms', 7) + '  error');
  for (const f of fails) {
    console.log(
      pad(iso(f.timestamp), 21) +
        pad(f.op, 20) +
        pad(f.model_id, 34) +
        padL(f.inp, 7) +
        padL(f.out, 6) +
        padL(f.ms, 7) +
        '  ' + String(f.err).slice(0, 44),
    );
  }
}
console.log('');

/* ---------- 3. 确定性判据：同一 (op, model, error) 的输入是否单调增长 ---------- */
console.log('== 3. 确定性判据（同 op+model+error 的失败串）==');
const groups = db
  .prepare(
    `SELECT operation_type AS op, model_id, error_message AS err,
            COUNT(*) AS n, MIN(input_tokens) AS min_in, MAX(input_tokens) AS max_in,
            MIN(timestamp) AS first_at, MAX(timestamp) AS last_at,
            SUM(CASE WHEN output_tokens = 0 THEN 1 ELSE 0 END) AS zero_out
       FROM llm_audit_logs
      WHERE timestamp >= ? AND error_message IS NOT NULL AND error_message <> ''
      ${ONLY_OP ? 'AND operation_type = ?' : ''}
      GROUP BY 1, 2, 3 HAVING COUNT(*) >= 2
      ORDER BY n DESC`,
  )
  .all(...(ONLY_OP ? [since, ONLY_OP] : [since]));

if (!groups.length) {
  console.log('(没有重复出现的失败组合 → 更像偶发失败)');
}
for (const g of groups) {
  const span = (new Date(g.last_at) - new Date(g.first_at)) / 6e4;
  console.log(
    `${g.op} / ${g.model_id} / "${String(g.err).slice(0, 28)}"`,
  );
  console.log(
    `   次数 ${g.n}，input_tokens ${g.min_in} → ${g.max_in}，` +
      `跨度 ${span.toFixed(0)} 分钟，output=0 的有 ${g.zero_out} 条`,
  );
  console.log(
    g.min_in !== g.max_in
      ? '   → 同一窗口被反复重试（输入在长大），符合「确定性失败 + 不推进游标」'
      : '   → 输入完全相同，更像是同文同温重试',
  );
}
console.log('');

/* ---------- 4. 游标：哪些会话卡住了 ---------- */
console.log('== 4. distill_cursors（游标停在原地 = 同一窗口会被反复重试）==');
// 注意：llm_audit_logs 的 session_key 对 summarize_compress / dream_* / entity_extract
// 恒为 NULL（只有 write_admission 有值），因此无法把审计行归属到具体会话。
// 下面「> 游标时间」的失败数是全局计数，只能当参考，不能当作「这个会话又失败了几次」。
const skRows = db
  .prepare(
    `SELECT operation_type AS op, COUNT(*) AS n,
            SUM(CASE WHEN session_key IS NULL THEN 1 ELSE 0 END) AS null_sk
       FROM llm_audit_logs WHERE timestamp >= ? GROUP BY 1 ORDER BY n DESC`,
  )
  .all(since);
const unattributed = skRows.filter((r) => r.n === r.null_sk).map((r) => r.op);
console.log(
  unattributed.length
    ? `审计行无会话归属（session_key 全 NULL）：${unattributed.join('、')}`
    : '审计行均带 session_key，可按会话归属',
);
const lastOk = db
  .prepare(
    `SELECT MAX(timestamp) AS t FROM llm_audit_logs
      WHERE operation_type = 'summarize_compress' AND status = 'success'`,
  )
  .get();
const lastErr = db
  .prepare(
    `SELECT MAX(timestamp) AS t FROM llm_audit_logs
      WHERE operation_type = 'summarize_compress' AND error_message = 'invalid summary JSON'`,
  )
  .get();
console.log(`summarize_compress 最近一次成功 ${iso(lastOk.t)} / 最近一次 invalid summary JSON ${iso(lastErr.t)}`);

const cursors = db
  .prepare('SELECT session_id, last_seq, updated_at FROM distill_cursors ORDER BY updated_at DESC LIMIT 20')
  .all();
for (const c of cursors) {
  console.log(`${pad(c.session_id, 48)} last_seq=${padL(c.last_seq, 6)}  updated=${iso(c.updated_at)}`);
}
console.log(
  `共 ${cursors.length} 个游标；游标本身只存 last_seq，不含「失败次数」或「已放弃」状态，` +
    '所以失败窗口在下次触发时必然被重新取到。',
);
console.log('');

/* ---------- 5. 元数据现状（为什么排障只能靠外部复现）---------- */
const meta = db
  .prepare(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN metadata IS NULL THEN 1 ELSE 0 END) AS null_meta
       FROM llm_audit_logs WHERE timestamp >= ?`,
  )
  .get(since);
const metaErr = db
  .prepare(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN metadata IS NULL THEN 1 ELSE 0 END) AS null_meta
       FROM llm_audit_logs WHERE timestamp >= ? AND error_message IS NOT NULL`,
  )
  .get(since);
console.log('== 5. metadata 留存情况 ==');
console.log(`全部审计行 ${meta.n} 条，metadata 为 NULL 的 ${meta.null_meta} 条`);
console.log(
  `其中失败行 ${metaErr.n} 条，metadata 为 NULL 的 ${metaErr.null_meta} 条` +
    (metaErr.n > 0 && metaErr.null_meta === metaErr.n ? '（失败行无一例外）' : ''),
);
console.log('→ 失败时审计里不保存模型原始输出，所以「模型到底吐了什么」只能靠外部复现（见 repro-prompt.mjs）');

db.close();
