#!/usr/bin/env node
/**
 * scan-sections.cjs — 只读：列出 DSH profile 里所有客户端插件声明的 settings.section
 *
 * 目的：settings.section 是**共享槽位**，id 冲突时后注册者要么静默覆盖、要么
 * 抛出并中断自己的 client 初始化（见 dsh-repro 0016 / 0017）。第一步只做「看清
 * 现实」：谁注册了哪个 id、order 多少、注册是否被 try/catch 吞掉。
 *
 * 本脚本只读文件，不加载任何插件、不连宿主、不写任何东西。
 *
 * 用法：
 *   node scan-sections.cjs                 # 扫描 ~/.dsh/profiles 下所有 profile，并给出判定
 *   node scan-sections.cjs --root <dir>    # 指定目录（含 node_modules 的 profile 目录或直接是 node_modules）
 *   node scan-sections.cjs --json          # 机器可读（含 verdict / hard / soft / selfDup）
 *   node scan-sections.cjs --all-slots     # 不只 settings.section，列出所有槽位注册
 *   node scan-sections.cjs --selftest      # 只跑判定器自检（合成数据），不扫机器
 *
 * 退出码：0 = 扫描（或自检）完成 —— 有没有冲突不影响退出码；1 = --selftest 判定器没通过；2 = 参数/环境错误。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TARGET_SLOT = /^settings\.section(\.icon)?$/;
const MAX_FILE_BYTES = 12 * 1024 * 1024;

function parseArgs(argv) {
  const out = { root: null, json: false, allSlots: false, selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--all-slots') out.allSlots = true;
    else if (a === '--selftest') out.selftest = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else { console.error(`未知参数：${a}`); process.exit(2); }
  }
  return out;
}

function isDirLike(p, e) {
  if (e && e.isDirectory()) return true;
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * 把 root 归一化成「profile 目录列表」。
 * 顺序要紧：~/.dsh/profiles 自己也有一个 node_modules（宿主的共享依赖仓库，
 * 里面只有空的 @scope 壳），所以**先看子目录里有没有 profile**，再看自己。
 */
function resolveProfiles(root) {
  if (!fs.existsSync(root)) throw new Error(`目录不存在：${root}`);
  if (path.basename(root) === 'node_modules') return [{ name: path.basename(path.dirname(root)), nm: root }];

  const children = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && isDirLike(path.join(root, e.name), e))
    .map((e) => e.name)
    .filter((n) => fs.existsSync(path.join(root, n, 'node_modules')));
  if (children.length > 0) {
    return children.map((n) => ({ name: n, nm: path.join(root, n, 'node_modules') }));
  }

  const nm = path.join(root, 'node_modules');
  if (fs.existsSync(nm)) return [{ name: path.basename(root), nm }];
  return [];
}

/** 列出 node_modules 下的包目录（含 @scope/name） */
function listPackages(nm) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(nm, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const dir = path.join(nm, e.name);
    if (!isDirLike(dir, e)) continue;
    if (e.name.startsWith('@')) {
      let subs = [];
      try { subs = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const s of subs) {
        if (s.name.startsWith('.')) continue;
        if (isDirLike(path.join(dir, s.name), s)) out.push(path.join(dir, s.name));
      }
    } else {
      out.push(dir);
    }
  }
  return out;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** 按 DSH 插件约定找客户端入口文件（exports["./client"] 优先） */
function resolveClientEntry(pkgDir, pkg) {
  const tries = [];
  const ex = pkg.exports && pkg.exports['./client'];
  if (typeof ex === 'string') tries.push(ex);
  else if (ex && typeof ex === 'object') {
    for (const k of ['import', 'require', 'browser', 'default']) if (typeof ex[k] === 'string') tries.push(ex[k]);
  }
  const hasClient = Array.isArray(pkg.dsh) ? pkg.dsh.includes('client') : false;
  if (hasClient) tries.push('./lib/client.js', './client.js', './dist/client.js', './lib/client/index.js');
  tries.push(pkg.main);
  for (const t of tries) {
    if (typeof t !== 'string') continue;
    const p = path.join(pkgDir, t);
    const cands = [p, `${p}.js`, `${p}.cjs`, `${p}.mjs`, path.join(p, 'index.js')];
    for (const c of cands) {
      try { if (fs.statSync(c).isFile()) return c; } catch { /* 下一个 */ }
    }
  }
  return null;
}

/** 文件里 `const X = "literal"` 形式的常量表，用于解析 id: SECTION_ID */
function buildConstMap(text) {
  const map = new Map();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])((?:\\.|(?!\2)[^\\])*)\2/g;
  let m; let n = 0;
  while ((m = re.exec(text)) !== null && n++ < 4000) map.set(m[1], m[3]);
  return map;
}

function unquote(s) {
  return s.replace(/\\(["'\\])/g, '$1');
}

/**
 * 从一个客户端文件里抽出槽位注册。
 * 面向两种现实写法：
 *   slots.register({ name: "settings.section", id: X, order: N, ... }, Component)
 *   slots.register({ name:"settings.section", id:"x", order:1, ... })
 */
function extractRegistrations(text, opts) {
  const consts = buildConstMap(text);
  const results = [];
  const slotRe = /name\s*:\s*(["'])([A-Za-z][\w-]*(?:\.[\w-]+)*)\1/g;
  let m;
  while ((m = slotRe.exec(text)) !== null) {
    const slot = m[2];
    if (!opts.allSlots && !TARGET_SLOT.test(slot)) continue;
    const win = text.slice(m.index, m.index + 1200);

    // id: "literal"  或  id: IDENT
    let id = null; let idKind = 'literal';
    const idLit = /[,{]\s*id\s*:\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/.exec(win);
    if (idLit) id = unquote(idLit[2]);
    else {
      const idIdent = /[,{]\s*id\s*:\s*([A-Za-z_$][\w$]*)/.exec(win);
      if (idIdent) {
        idKind = 'const';
        id = consts.has(idIdent[1]) ? consts.get(idIdent[1]) : `<${idIdent[1]}>`;
      }
    }
    if (id === null) continue; // contextMenu.icon 之类用 key 的写法没有 id

    let order = null;
    const ordNum = /[,{]\s*order\s*:\s*(-?\d+(?:\.\d+)?)/.exec(win);
    const ordIdent = /[,{]\s*order\s*:\s*([A-Za-z_$][\w$]*)/.exec(win);
    if (ordNum) order = Number(ordNum[1]);
    else if (ordIdent) {
      const v = consts.get(ordIdent[1]);
      order = v !== undefined && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null;
    }

    // 注册被 try/catch 吞掉？看注册语句前后
    const before = text.slice(Math.max(0, m.index - 260), m.index);
    const after = text.slice(m.index, m.index + 1600);
    const inTry = /try\s*\{/.test(before);
    const hasCatch = /\}\s*catch\b/.test(after);

    results.push({ slot, id, idKind, order, swallowed: inTry && hasCatch, at: m.index });
  }
  return results;
}

function pad(s, n) {
  const str = String(s === null || s === undefined ? '·' : s);
  const w = [...str].length;
  if (w > n) {
    const head = [...str].slice(0, 3).join('');
    const tail = [...str].slice(w - (n - 4)).join('');
    return `${head}…${tail} `;
  }
  return str + ' '.repeat(n - w);
}

/**
 * 判定器：把「扫描到的注册」变成「有没有可能撞车」。
 *
 * 三类问题，性质完全不同：
 *   hard  同 id **同 order**，来自不同包 —— 两个设置页要挤同一个位置，后注册者必受影响；
 *         order 都缺失时也算 hard，因为无法证明两者位置不同。
 *   soft  同 id **不同 order**，来自不同包 —— 位置不同但仍共用一个 id，
 *         宿主是「后者覆盖前者」还是「后者报错」，取决于实现（0016 / 0017 就是这两种结局）。
 *   selfDup 同一个包对同一个 id 注册多次 —— 通常是「挂载期一次 + slots.inject 里一次」的双路径，
 *         多数情况下互斥，但若两条路径都触发，第二次注册的成败就没人管了。
 *
 * swallowed（注册被 try/catch 吞掉）不单独算问题，但会稀释上面三类的可见性：
 * 冲突发生了而注册方静默失败，用户看到的现象只是「设置页没了」。
 */
function judge(rows) {
  const hard = [];
  const soft = [];
  const selfDup = [];
  const clean = [];

  const bySlotId = new Map();
  for (const r of rows) {
    if (!/^settings\.section(\.icon)?$/.test(r.slot)) continue;
    const k = `${r.profile}\u0000${r.slot}\u0000${r.id}`;
    if (!bySlotId.has(k)) bySlotId.set(k, []);
    bySlotId.get(k).push(r);
  }

  for (const [, list] of bySlotId) {
    const pkgs = [...new Set(list.map((r) => r.package))];
    if (pkgs.length > 1) {
      const orders = [...new Set(list.map((r) => (r.order === null ? null : r.order)))];
      const sameSlot = list[0].slot;
      const entry = {
        profile: list[0].profile,
        slot: sameSlot,
        id: list[0].id,
        registrants: list.map((r) => ({
          package: r.package, version: r.version, order: r.order, swallowed: r.swallowed, file: r.file,
        })),
      };
      // 同 order（含双方都缺失）→ 硬冲突；否则软冲突
      if (orders.length === 1) hard.push(entry);
      else soft.push(entry);
      continue;
    }
    // 同一个包：多行，或同一行自带 sites>1（同包多处 register 会被合并计数）
    if (list.length > 1 || list.some((r) => (r.sites || 1) > 1)) selfDup.push({
      profile: list[0].profile,
      slot: list[0].slot,
      id: list[0].id,
      package: list[0].package,
      version: list[0].version,
      sites: list.reduce((n, r) => n + (r.sites || 1), 0),
      swallowed: list.some((r) => r.swallowed),
      file: list[0].file,
    });
    else clean.push(list[0]);
  }

  const swallowedRows = rows.filter((r) => r.swallowed && /^settings\.section/.test(r.slot));
  const verdict = hard.length > 0 ? 'CONFLICT' : soft.length > 0 ? 'SUSPECT' : 'CLEAN';

  return { verdict, hard, soft, selfDup, clean, swallowed: swallowedRows };
}

/** 自检：用合成数据喂同一判定器，要求它分别判出 HARD / SOFT / SELF / CLEAN */
function selftest() {
  const mk = (o) => ({
    profile: 'p', package: 'pkg-a', version: '1.0.0', slot: 'settings.section',
    id: 'x', order: 0, swallowed: false, file: 'a/client.js', sites: 1, ...o,
  });
  const cases = [
    {
      name: '两包同 id 同 order → 硬冲突',
      rows: [mk({ id: 'archived-sessions', package: 'a', order: 0 }), mk({ id: 'archived-sessions', package: 'b', order: 0 })],
      expect: { verdict: 'CONFLICT', hard: 1, soft: 0 },
    },
    {
      name: '两包同 id 不同 order → 软冲突',
      rows: [mk({ id: 'archived-sessions', package: 'a', order: 0 }), mk({ id: 'archived-sessions', package: 'b', order: 45 })],
      expect: { verdict: 'SUSPECT', hard: 0, soft: 1 },
    },
    {
      name: '两包同 id、order 都缺失 → 判硬冲突（无法证明位置不同）',
      rows: [mk({ id: 'archived-sessions', package: 'a', order: null }), mk({ id: 'archived-sessions', package: 'b', order: null })],
      expect: { verdict: 'CONFLICT', hard: 1, soft: 0 },
    },
    {
      name: '同一个包注册两次同一 id → 同包重复，不算冲突',
      rows: [mk({ id: 'archive-manager', package: 'a', order: 45, sites: 2 })],
      expect: { verdict: 'CLEAN', hard: 0, soft: 0, selfDup: 1 },
    },
    {
      name: 'id 各不相同 → 干净（order 撞了也不算）',
      rows: [mk({ id: 'a1', package: 'a', order: 45 }), mk({ id: 'b1', package: 'b', order: 45 }), mk({ id: 'c1', package: 'c', order: 45 })],
      expect: { verdict: 'CLEAN', hard: 0, soft: 0, selfDup: 0 },
    },
    {
      name: 'settings.section.icon 与 settings.section 分开判',
      rows: [mk({ id: 'same', slot: 'settings.section', package: 'a' }), mk({ id: 'same', slot: 'settings.section.icon', package: 'b' })],
      expect: { verdict: 'CLEAN', hard: 0, soft: 0 },
    },
    {
      name: '冲突 + 注册被吞 → 冲突仍要报出来',
      rows: [mk({ id: 'y', package: 'a', order: 1 }), mk({ id: 'y', package: 'b', order: 1, swallowed: true })],
      expect: { verdict: 'CONFLICT', hard: 1, soft: 0, swallowed: 1 },
    },
  ];

  let fail = 0;
  for (const c of cases) {
    const r = judge(c.rows);
    const got = { verdict: r.verdict, hard: r.hard.length, soft: r.soft.length, selfDup: r.selfDup.length, swallowed: r.swallowed.length };
    const bad = Object.entries(c.expect).filter(([k, v]) => got[k] !== v);
    if (bad.length === 0) {
      console.log(`  ok    ${c.name}  → ${got.verdict} (hard=${got.hard} soft=${got.soft} self=${got.selfDup} swallowed=${got.swallowed})`);
    } else {
      fail++;
      console.log(`  FAIL  ${c.name}`);
      for (const [k, v] of bad) console.log(`        期望 ${k}=${v}，实际 ${k}=${got[k]}`);
    }
  }
  console.log('');
  if (fail === 0) { console.log(`自检通过：${cases.length}/${cases.length} 个合成用例判定正确。`); return 0; }
  console.error(`自检失败：${fail}/${cases.length} 个用例不符合预期 —— 判定器本身有问题，先修它，别信它的结论。`);
  return 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return; }
  if (args.selftest) {
    console.log('判定器自检：用合成注册数据喂同一判定函数，要求它分别判出硬冲突 / 软冲突 / 同包重复 / 干净。');
    console.log('');
    process.exit(selftest());
  }

  const root = path.resolve(args.root || path.join(os.homedir(), '.dsh', 'profiles'));
  const profiles = resolveProfiles(root);
  if (profiles.length === 0) { console.error(`在 ${root} 下没找到带 node_modules 的 profile`); process.exit(2); }

  const rows = [];
  let pkgCount = 0; let clientCount = 0; let fileCount = 0;

  for (const prof of profiles) {
    for (const pkgDir of listPackages(prof.nm)) {
      const pj = path.join(pkgDir, 'package.json');
      const pkg = readJson(pj);
      if (!pkg || !pkg.name) continue;
      pkgCount++;
      const entry = resolveClientEntry(pkgDir, pkg);
      if (!entry) continue;
      clientCount++;
      let text;
      try {
        const st = fs.statSync(entry);
        if (st.size > MAX_FILE_BYTES) continue;
        text = fs.readFileSync(entry, 'utf8');
      } catch { continue; }
      fileCount++;
      for (const r of extractRegistrations(text, args)) {
        rows.push({
          profile: prof.name,
          package: pkg.name,
          version: pkg.version || '?',
          slot: r.slot,
          id: r.id,
          order: r.order,
          swallowed: r.swallowed,
          file: path.relative(prof.nm, entry).split(path.sep).join('/'),
        });
      }
    }
  }

  rows.sort((a, b) => a.slot.localeCompare(b.slot) || String(a.id).localeCompare(String(b.id)) || a.profile.localeCompare(b.profile));

  // 同一个包里可能有多处 register（挂载期一次 + slots.inject 里一次），合并计数
  const merged = [];
  const seen = new Map();
  for (const r of rows) {
    const k = [r.profile, r.package, r.version, r.slot, r.id, r.order, r.swallowed, r.file].join('\u0000');
    const hit = seen.get(k);
    if (hit) { hit.sites++; continue; }
    const row = { ...r, sites: 1 };
    seen.set(k, row);
    merged.push(row);
  }

  if (args.json) {
    const v = judge(merged);
    console.log(JSON.stringify({
      root,
      profiles: profiles.map((p) => p.name),
      scanned: { packages: pkgCount, withClientEntry: clientCount, filesRead: fileCount },
      verdict: v.verdict,
      hard: v.hard,
      soft: v.soft,
      selfDup: v.selfDup,
      swallowed: v.swallowed.map((r) => ({ package: r.package, version: r.version, slot: r.slot, id: r.id })),
      rows: merged,
    }, null, 2));
    return;
  }

  console.log(`根目录   ${root}`);
  console.log(`profile  ${profiles.map((p) => p.name).join(', ')}`);
  console.log(`扫描     ${pkgCount} 个包 → ${clientCount} 个有客户端入口 → 读入 ${fileCount} 个文件（只读）`);
  console.log('');

  if (merged.length === 0) {
    console.log('没有发现任何 settings.section 注册。');
    return;
  }

  const sections = merged.filter((r) => r.slot === 'settings.section');
  console.log(`settings.section 注册共 ${sections.length} 处（去重后），来自 ${new Set(sections.map((r) => r.package)).size} 个包。`);
  console.log('');
  console.log(`${pad('槽位', 22)}${pad('id', 26)}${pad('order', 7)}${pad('吞异常', 8)}${pad('包@版本', 52)}文件`);
  console.log('-'.repeat(126));
  for (const r of merged) {
    const where = `${r.package}@${r.version}`;
    const sites = r.sites > 1 ? `  ×${r.sites}` : '';
    console.log(
      `${pad(r.slot, 22)}${pad(r.id, 26)}${pad(r.order, 7)}${pad(r.swallowed ? 'yes' : '·', 8)}${pad(where, 52)}${r.file}${sites}`,
    );
  }

  const v = judge(merged);
  console.log('');
  console.log(`判定 ${v.verdict}   （CONFLICT = 有硬冲突 / SUSPECT = 只有软冲突 / CLEAN = 无同 id 撞车）`);
  console.log('-'.repeat(126));

  const showGroup = (title, list, hint) => {
    console.log(`${title}：${list.length === 0 ? '无' : `${list.length} 处`}`);
    if (list.length === 0) { console.log(`  ${hint}`); return; }
    for (const g of list) {
      console.log(`  ${g.slot} · ${g.id}`);
      for (const r of g.registrants) {
        console.log(`    - ${r.package}@${r.version}  order=${r.order === null ? '·' : r.order}${r.swallowed ? '  (注册被 try/catch 吞掉)' : ''}  ${r.file}`);
      }
    }
  };

  showGroup('硬冲突（同 id 同 order，来自不同包）', v.hard, '（含义：两个设置页要挤同一个位置，后注册者必然受影响）');
  console.log('');
  showGroup('软冲突（同 id 不同 order，来自不同包）', v.soft, '（含义：位置不同但仍共用一个 id，结局取决于宿主是覆盖还是报错）');
  console.log('');

  console.log(`同包重复注册（同一个包对同一个 id 注册多次）：${v.selfDup.length === 0 ? '无' : `${v.selfDup.length} 处`}`);
  if (v.selfDup.length === 0) {
    console.log('  （没有包对同一个 id 注册两次）');
  } else {
    for (const s of v.selfDup) {
      console.log(`  - ${s.package}@${s.version}  ${s.slot} · ${s.id}  ${s.sites} 处${s.swallowed ? '（注册被 try/catch 吞掉）' : ''}  ${s.file}`);
    }
  }
  console.log('');

  console.log(`注册被 try/catch 吞掉：${v.swallowed.length} 处`);
  if (v.swallowed.length > 0) {
    const involved = new Set([...v.hard, ...v.soft].map((g) => `${g.profile}\u0000${g.id}`));
    const blind = v.swallowed.filter((r) => involved.has(`${r.profile}\u0000${r.id}`));
    console.log(`  其中 ${blind.length} 处涉及冲突 —— 失败被吞掉时，用户看到的现象只是「设置页没了」`);
    for (const r of v.swallowed) console.log(`  - ${r.package}@${r.version}  ${r.slot} · ${r.id}`);
  }
  console.log('');
  console.log('备注：这是**静态**扫描（读客户端 bundle 里的注册字面量），不等于运行时结果；');
  console.log('      动态注入（按需 register）的插件只能看到字面量，不代表它此刻真的注册了。');
  console.log('      判定器本身用 --selftest 自检（合成数据），先信自检再信结论。');
}

main();
