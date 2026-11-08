#!/usr/bin/env node
/**
 * mneme 审计器 · 保留期这一侧（对应上游 slow-stack/mneme#557）
 *
 * 判的问题只有一个：**dream_runs 这张审计表，有没有人负责让它变老、变小？**
 *
 * 为什么值得单独审计：#557 报告的是「dream_runs 没有保留期键且无界增长，实测占库约 43% 的页，
 * 而四个 *RetentionDays 都不覆盖它」。这类缺陷的特点是**用户永远收不到报错**——库只是慢慢变大，
 * 直到某天备份、迁移、快照全变慢。所以要有一条命令随时能回答「我这个版本里它还漏着吗」。
 *
 * 做法：只读源码 + 只读数据库，两件事分别判：
 *   源码侧 A  dream_runs 本表有没有 DELETE 路径（真正的删除）
 *   源码侧 B  有没有一个保留期配置键落到 dream_runs 上
 *   源码侧 C  有没有「只清 input 列」的裁剪入口（0.12.0 新增的部分缓解）
 *   数据侧 D  实测：行数 / 占库页比 / input 字节 / 最新一行时间（现场证据，不参与结论）
 *
 * 结论三档：
 *   FIXED    有删除路径且有保留期键 —— 表会自己变小
 *   PARTIAL  没有删除路径，但有 input 裁剪 —— 只治了最肥的那一列，行本身永久保留
 *   DEFECT   两者都没有 —— 无界增长
 *
 * 用法：
 *   node audit-retention.cjs                       # 自动找 profile 里的 mneme + 默认库路径
 *   node audit-retention.cjs --plugin <dir> --db <file>
 *   node audit-retention.cjs --json
 *   node audit-retention.cjs --selftest            # 用合成源码 + 内存库验判定器本身
 *
 * 退出码：0 = 审计跑完（缺陷有无不体现在退出码）；1 = --selftest 没通过；2 = 参数/环境错误。
 *
 * 只读承诺：数据库用 readOnly 打开，源码只 readFileSync，全程不写一个字节。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const DEFAULT_DB = path.join(HOME, '.dsh', 'memory', 'memory.db');
const MNEME_PKG = '@modusensus/dsh-mneme';

function parseArgs(argv) {
  const out = { plugin: null, db: null, json: false, selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plugin') out.plugin = argv[++i];
    else if (a === '--db') out.db = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--selftest') out.selftest = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else { console.error(`未知参数：${a}`); process.exit(2); }
  }
  return out;
}

/** 在 ~/.dsh/profiles/<name>/node_modules 里找 mneme；找不到就返回 null */
function findPlugin(explicit) {
  if (explicit) {
    const p = path.resolve(explicit);
    return fs.existsSync(path.join(p, 'package.json')) ? p : null;
  }
  const roots = [path.join(HOME, '.dsh', 'profiles'), path.join(HOME, '.dsh')];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const cand = path.join(root, e.name, 'node_modules', MNEME_PKG);
      if (fs.existsSync(path.join(cand, 'package.json'))) return cand;
    }
    const direct = path.join(root, 'node_modules', MNEME_PKG);
    if (fs.existsSync(path.join(direct, 'package.json'))) return direct;
  }
  return null;
}

/** 读一个文件；读不到返回空串（判定函数对空串是安全的：全判「没有」） */
function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

// ── 源码侧判定：纯函数，吃文本吐布尔，便于 selftest 喂合成源码 ──────────────────

/** A：dream_runs 本表有没有真正的 DELETE 路径 */
function hasDreamRunDelete(storeSrc) {
  if (/DELETE\s+FROM\s+dream_runs/i.test(storeSrc)) return true;
  // 命名约定兜底：deleteOldDreamRuns / purgeDreamRuns 之类的函数名（内部通常拼 DELETE）
  return /\b(?:delete|purge|prune)Dream(?:Run|Runs)\b/i.test(storeSrc);
}

/** C：有没有只清 input 列的裁剪（UPDATE dream_runs SET input = NULL） */
function hasDreamRunInputTrim(storeSrc) {
  return /UPDATE\s+dream_runs\s+SET\s+[\s\S]{0,80}?input\s*=\s*NULL/i.test(storeSrc);
}

/** B：有没有保留期配置键落到 dream_runs 上 */
function hasDreamRunRetentionKey(configSrc) {
  return /\bdream(?:Run|Runs)?RetentionDays\b/i.test(configSrc);
}

/**
 * 列出所有保留期键及其默认值，并尽力标出它挂在哪个父键下。
 * 只认 `xxxDays: z.natural()...default(N)` / `retentionDays: z.natural()...default(N)` 这种形态，
 * 解析失败只记 `·`，不做猜测 —— 宁可少报也不编。
 */
function collectRetentionKeys(configSrc) {
  const out = [];
  const lines = configSrc.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\s*(\w+)\s*:\s*z\.natural\([^)]*\)[\s\S]*?default\(\s*(\d+)\s*\)/);
    if (!m) continue;
    const key = m[1];
    if (!/retentionDays$/i.test(key)) continue;
    // 往上找最近一个 `foo: z.object({` 作为父键
    let parent = '·';
    for (let j = i - 1; j >= 0 && j > i - 80; j--) {
      const pm = lines[j].match(/^\s{0,4}(\w+)\s*:\s*z\.object\(/);
      if (pm) { parent = pm[1]; break; }
    }
    out.push({ path: parent === '·' ? key : `${parent}.${key}`, days: Number(m[2]) });
  }
  return out;
}

/**
 * 每个 purge/delete 函数删的是哪张表 —— 用来回答「这些保留期键到底覆盖了什么」。
 * 只做词法配对：函数名 + 函数体内第一个 DELETE FROM。
 */
function collectPurgeTargets(storeSrc) {
  const out = [];
  const re = /function\s+((?:purge|deleteOld)\w*)\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = re.exec(storeSrc)) !== null) {
    const name = m[1];
    const body = storeSrc.slice(m.index, m.index + 1200);
    const d = body.match(/DELETE\s+FROM\s+(\w+)/i) || body.match(/UPDATE\s+(\w+)\s+SET/i);
    out.push({ fn: name, table: d ? d[1] : '·' });
  }
  return out;
}

/** 判定器：把三件事合成三档结论 */
function judge(src, cfg, retentionTargets) {
  const del = hasDreamRunDelete(src);
  const trim = hasDreamRunInputTrim(src);
  const key = hasDreamRunRetentionKey(cfg);
  const coversTable = retentionTargets.some((t) => t.table === 'dream_runs');

  let verdict;
  if (del && (key || coversTable)) verdict = 'FIXED';
  else if (!del && !key && !coversTable && trim) verdict = 'PARTIAL';
  else if (!del && !key && !coversTable && !trim) verdict = 'DEFECT';
  else if (!del && (key || coversTable)) verdict = 'SUSPECT'; // 有保留期键却没有删除路径：键是死的
  else verdict = 'PARTIAL'; // 有删除路径但没有任何保留期键 → 只能手动清，仍算部分

  return { verdict, deletePath: del, retentionKey: key, inputTrim: trim, coveredByPurge: coversTable };
}

// ── 数据侧：只读打开库，量它有多胖 ───────────────────────────────────────────

function measureDb(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const get = (s, ...a) => db.prepare(s).get(...a);
  const all = (s, ...a) => db.prepare(s).all(...a);
  const res = { path: dbPath };
  try {
    res.fileBytes = fs.statSync(dbPath).size;
    res.pageSize = get('PRAGMA page_size').page_size;
    res.pageCount = get('PRAGMA page_count').page_count;
    res.freelist = get('PRAGMA freelist_count').freelist_count;
    res.dbBytes = res.pageSize * res.pageCount;
    try {
      res.dreamRunPageBytes = get('SELECT SUM(pgsize) s FROM dbstat WHERE name = ?', 'dream_runs').s || 0;
    } catch { res.dreamRunPageBytes = null; } // 没有 dbstat vtab 时留空，不硬算
    const s = get('SELECT COUNT(*) n, MIN(created_at) a, MAX(created_at) b FROM dream_runs');
    res.rows = s.n; res.firstAt = s.a; res.lastAt = s.b;
    res.inputBytes = get("SELECT SUM(LENGTH(COALESCE(input,''))) b FROM dream_runs").b || 0;
    res.inputRows = get('SELECT COUNT(*) c FROM dream_runs WHERE input IS NOT NULL').c;
    res.byType = all('SELECT run_type, COUNT(*) n FROM dream_runs GROUP BY run_type ORDER BY n DESC')
      .map((r) => ({ type: r.run_type || '·', n: r.n }));
  } finally {
    db.close();
  }
  res.share = res.dreamRunPageBytes == null ? null : res.dreamRunPageBytes / res.dbBytes;
  return res;
}

// ── selftest ───────────────────────────────────────────────────────────────

const FIXTURE_DEFECT = `
  function dreamRunInputStats(before) { /* 只统计，不删 */ }
  function clearDreamRunInputs(before) { return db.prepare('UPDATE recall_runs SET x = 1').run(); }
`;
const FIXTURE_PARTIAL = `
  function clearDreamRunInputs(before) {
    return db.prepare(\`UPDATE dream_runs SET input = NULL
      WHERE input IS NOT NULL AND created_at < ?\`).run(before).changes;
  }
`;
const FIXTURE_FIXED = `
  function deleteOldDreamRuns(before) {
    return db.prepare('DELETE FROM dream_runs WHERE created_at < ?').run(before).changes;
  }
`;
const CFG_NO_KEY = `\n    retentionDays: z.natural().min(1).max(3650).default(90)\n`;
const CFG_WITH_KEY = `\n    dreamRunsRetentionDays: z.natural().min(1).max(3650).default(90)\n`;

function selftest() {
  const cases = [
    { name: '无删除 + 无键 + 无 input 裁剪 → DEFECT', src: FIXTURE_DEFECT, cfg: CFG_NO_KEY, targets: [], expect: 'DEFECT' },
    { name: '无删除 + 无键 + 有 input 裁剪 → PARTIAL', src: FIXTURE_PARTIAL, cfg: CFG_NO_KEY, targets: [], expect: 'PARTIAL' },
    { name: '有删除 + 有保留期键 → FIXED', src: FIXTURE_FIXED, cfg: CFG_WITH_KEY, targets: [], expect: 'FIXED' },
    { name: '有删除 + 仅靠他表 purge 间接覆盖 → FIXED', src: FIXTURE_FIXED, cfg: CFG_NO_KEY, targets: [{ fn: 'purgeX', table: 'dream_runs' }], expect: 'FIXED' },
    { name: '有保留期键但无删除路径（键是死的）→ SUSPECT', src: FIXTURE_DEFECT, cfg: CFG_WITH_KEY, targets: [], expect: 'SUSPECT' },
  ];
  let fail = 0;
  for (const c of cases) {
    const r = judge(c.src, c.cfg, c.targets);
    if (r.verdict === c.expect) {
      console.log(`  ok    ${c.name}`);
    } else {
      fail++;
      console.log(`  FAIL  ${c.name}\n        期望 ${c.expect}，实际 ${r.verdict}`);
    }
  }

  // 数据侧：内存库造 3 行已知大小的 dream_runs，验 measureDb 的算术
  // node:sqlite 需要 Node ≥ 22.5（22.x 还需 --experimental-sqlite，23.4+ 默认可用）。
  // 旧版本上没有它时跳过这一段，判为 skip 而不是失败 —— 源码侧五组仍然照跑。
  try {
    require('node:sqlite');
  } catch (e) {
    if (e.code === 'ERR_UNKNOWN_BUILTIN_MODULE') {
      console.log(`  skip  数据侧算术：当前 Node ${process.version} 没有 node:sqlite（需 ≥ 22.5），跳过`);
      console.log('');
      if (fail === 0) { console.log(`自检通过：${cases.length}/${cases.length} 个用例判定正确（数据侧已跳过）。`); return 0; }
      return 1;
    }
    throw e;
  }
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-audit-'));
  const p = path.join(dir, 'mem.db');
  const db = new DatabaseSync(p);
  db.exec(`CREATE TABLE dream_runs (id TEXT, created_at TEXT, run_type TEXT, input TEXT);`);
  const ins = db.prepare('INSERT INTO dream_runs VALUES (?,?,?,?)');
  ins.run('1', '2026-01-01T00:00:00Z', 'auto', 'x'.repeat(1000));
  ins.run('2', '2026-01-02T00:00:00Z', 'auto', 'y'.repeat(2000));
  ins.run('3', '2026-01-03T00:00:00Z', 'organize', null);
  db.close();
  try {
    const m = measureDb(p);
    const ok = m.rows === 3 && m.inputBytes === 3000 && m.inputRows === 2 && m.lastAt === '2026-01-03T00:00:00Z';
    if (ok) console.log(`  ok    数据侧：内存库 3 行 / input 3000 字节 / 2 行有 input → 量对了`);
    else { fail++; console.log(`  FAIL  数据侧：rows=${m.rows} input=${m.inputBytes} inputRows=${m.inputRows} last=${m.lastAt}`); }
  } catch (e) {
    fail++;
    console.log(`  FAIL  数据侧量取抛错：${e.message}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log('');
  if (fail === 0) { console.log(`自检通过：${cases.length + 1}/${cases.length + 1} 个用例判定正确。`); return 0; }
  console.error(`自检失败：${fail}/${cases.length + 1} 个用例不符合预期 —— 先修判定器，别信它的结论。`);
  return 1;
}

// ── main ──────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return; }
  if (args.selftest) {
    console.log('判定器自检：合成源码（缺陷/部分/修好三种形状）+ 内存库算术。');
    console.log('');
    process.exit(selftest());
  }

  const plugin = findPlugin(args.plugin);
  if (!plugin) { console.error(`没找到 ${MNEME_PKG}。用 --plugin 指定安装目录。`); process.exit(2); }

  const pkg = JSON.parse(readText(path.join(plugin, 'package.json')) || '{}');
  const storeSrc = readText(path.join(plugin, 'lib', 'store.js'));
  const cfgSrc = readText(path.join(plugin, 'lib', 'config.js'));
  if (!storeSrc || !cfgSrc) { console.error(`插件目录里没有 lib/store.js 或 lib/config.js：${plugin}`); process.exit(2); }

  const targets = collectPurgeTargets(storeSrc);
  const keys = collectRetentionKeys(cfgSrc);
  const j = judge(storeSrc, cfgSrc, targets);

  const dbPath = path.resolve(args.db || DEFAULT_DB);
  let m = null;
  if (fs.existsSync(dbPath)) {
    try { m = measureDb(dbPath); } catch (e) { m = { error: e.message, path: dbPath }; }
  }

  if (args.json) {
    console.log(JSON.stringify({ plugin, version: pkg.version, verdict: j.verdict, checks: j, retentionKeys: keys, purgeTargets: targets, db: m }, null, 2));
    return;
  }

  const mark = (b) => (b ? 'ok  ' : 'MISS');
  console.log('mneme 保留期审计 · dream_runs（对应上游 #557）');
  console.log('');
  console.log(`插件     ${plugin}`);
  console.log(`版本     ${pkg.version || '·'}`);
  console.log('');
  console.log('源码侧');
  console.log(`  ${mark(j.deletePath)}  A  dream_runs 本表有 DELETE 路径`);
  console.log(`  ${mark(j.retentionKey)}  B  有保留期配置键落到 dream_runs（dreamRunsRetentionDays 之类）`);
  console.log(`  ${mark(j.inputTrim)}  C  有「只清 input 列」的裁剪入口（UPDATE dream_runs SET input = NULL）`);
  console.log('');
  console.log(`  现有保留期键（共 ${keys.length} 个）:`);
  if (keys.length === 0) console.log('    （一个也没解析出来 —— 可能上游改了写法，判定 B 需要人工确认）');
  for (const k of keys) console.log(`    - ${k.path}  默认 ${k.days} 天`);
  console.log('');
  console.log(`  清理函数 → 目标表（共 ${targets.length} 个）:`);
  for (const t of targets) console.log(`    - ${t.fn}() → ${t.table}`);
  const covers = targets.filter((t) => t.table === 'dream_runs').map((t) => t.fn);
  console.log(`    dream_runs 被覆盖：${covers.length ? covers.join(', ') + '()' : '**没有任何清理函数指向它**'}`);
  console.log('');

  if (!m) {
    console.log(`数据侧  没找到数据库：${dbPath}（用 --db 指定，或跳过）`);
  } else if (m.error) {
    console.log(`数据侧  读库失败：${m.error}`);
  } else {
    console.log('数据侧（现场证据，不参与结论）');
    console.log(`  库文件   ${(m.fileBytes / 1048576).toFixed(1)} MB · page ${m.pageSize} × ${m.pageCount} · freelist ${m.freelist} 页`);
    console.log(`  dream_runs ${m.rows} 行 · 占 ${(m.dreamRunPageBytes / 1048576).toFixed(2)} MB · ${m.share == null ? '·' : (m.share * 100).toFixed(1) + '% 的页'}`);
    console.log(`  input 列 ${(m.inputBytes / 1048576).toFixed(2)} MB（${m.inputRows} 行有值，平均 ${Math.round(m.inputBytes / Math.max(m.inputRows, 1) / 1024)} KB/行）`);
    console.log(`  时间跨度 ${m.firstAt || '·'} → ${m.lastAt || '·'}`);
    console.log(`  按类型   ${m.byType.map((t) => `${t.type} ${t.n}`).join(' · ') || '·'}`);
    if (m.share != null && m.share > 0.15) {
      console.log(`  提示     单表占库 ${(m.share * 100).toFixed(1)}%，行数却只有 ${m.rows} 行 —— 说明体积来自大 TEXT（input/decisions/outcome）而不是行数。`);
    }
  }

  console.log('');
  console.log(`结论 ${j.verdict}`);
  if (j.verdict === 'FIXED') console.log('  有删除路径且有保留期键：这张表会自己变老。');
  else if (j.verdict === 'PARTIAL') console.log('  行本身永久保留（没有 DELETE、没有保留期键），但有「只清 input 列」的裁剪入口 —— 只能治最肥的那一列。');
  else if (j.verdict === 'DEFECT') console.log('  既没有删除路径也没有保留期键：无界增长，与 #557 描述一致。');
  else console.log('  有保留期键却找不到删除路径（或相反）：键可能是死的，建议人工确认调用链。');
  console.log('');
  console.log('提醒：删行不会自动归还文件页（SQLite 需要 VACUUM 才缩文件），所以「清了但库没变小」是预期现象，不是没清。');
  console.log('      判定器本身用 --selftest 验（合成源码 + 内存库），先信自检再信结论。');
}

main();
