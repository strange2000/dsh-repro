#!/usr/bin/env node
'use strict'
/**
 * 只读审计：dsh-bili-scroll 在桌面版上的三处「装完直接用不了」是否还在。
 *
 * 背景见 ../reports/0003-dsh-bili-scroll.md。三处：
 *   Bug 1  pythonPath 被宿主那份启动快照压回 'python' ⇒ 出码 spawn 到微软商店存根（exit 9009）⇒ 点了没反应。
 *   Bug 2  保存设置时把**整份内存配置**写回磁盘 ⇒ 改一个键冲掉一片（三方值互相矛盾）。
 *   Bug 3  桌面版找不到 dsh（CLI 只在 app.asar 里）+ headless overlay 把 credentials 等三个服务关了 ⇒ 跑一轮必失败。
 *
 * 本脚本不启动插件、不跑一轮、不改任何配置：只读插件源码 + 只读现场的三份状态文件 + 只读探路。
 *
 * 用法：
 *   node audit-config.cjs                          # 插件/状态目录/profile 都按默认位置找
 *   node audit-config.cjs --plugin <插件目录>
 *   node audit-config.cjs --state <状态目录>        # 默认 ~/.dsh/bili-duty
 *   node audit-config.cjs --patch <cordis.patch.yml>
 *   node audit-config.cjs --json
 *   node audit-config.cjs --selftest               # 用两份合成源码验证判定器本身（离线可跑）
 *
 * 退出码：0 = 审计跑完（缺陷有无不体现在退出码上）；2 = 参数/环境错误。
 */

const fs = require('node:fs')
const path = require('node:path')

const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)
const flag = (n) => {
  const i = argv.indexOf('--' + n)
  const v = argv[i + 1]
  return i > -1 && v && !v.startsWith('--') ? v : null
}
const HOME = process.env.USERPROFILE || process.env.HOME || ''
const JSON_OUT = has('json')
const PLUGIN = flag('plugin') || path.join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-bili-scroll')
const STATE = flag('state') || path.join(HOME, '.dsh', 'bili-duty')
const PATCH = flag('patch') || path.join(HOME, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
const PKG_NAME = 'dsh-bili-scroll'

const readIf = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }
const readJson = (f) => { try { return JSON.parse(readIf(f) || 'null') } catch { return null } }
const exists = (f) => { try { return fs.existsSync(f) } catch { return false } }

/** 从源码里抠函数体（支持 function 声明与 const 箭头），按花括号配平；找不到返回 null。 */
function fnBody(src, name) {
  const pats = [
    new RegExp('(?:export\\s+)?function\\s+' + name + '\\s*\\([\\s\\S]{0,200}?\\)\\s*\\{'),
    new RegExp('(?:const|let|var)\\s+' + name + '\\s*=\\s*(?:async\\s*)?\\([\\s\\S]{0,200}?\\)\\s*=>\\s*\\{'),
    new RegExp('(?:const|let|var)\\s+' + name + '\\s*=\\s*(?:async\\s*)?[A-Za-z_$][\\w$]*\\s*=>\\s*\\{'),
  ]
  for (const re of pats) {
    const m = re.exec(src)
    if (!m) continue
    let i = m.index + m[0].length - 1
    let depth = 0
    const start = i
    for (; i < src.length; i++) {
      const c = src[i]
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) return src.slice(start, i + 1)
      }
    }
  }
  return null
}

/* ------------------------------------------------------------------ 判定器 */
/**
 * 只看源码文本，不执行插件代码 —— 对任何版本都安全。
 * checks[].ok === null 表示仅供参照、不参与结论。
 */
function auditSources(src) {
  const checks = []

  // B1 读路径：配置基准是「宿主启动快照 config」还是「设置行现值 row.value」。
  //    缺陷版：const out = { ...hostCfg() } —— hostCfg 拿的是 apply() 时的快照。
  const usesSnapshot = /const out\s*=\s*\{\s*\.\.\.hostCfg\(\)\s*\}/.test(src)
  const usesRowValue = /normalize\(\s*row\.value/.test(src) || /row\.value\s*&&/.test(src)
  checks.push({
    id: 'B1',
    title: 'loadCfg 的宿主基准：启动快照 / 设置行现值',
    detail: usesSnapshot
      ? '仍以 hostCfg()（apply 时的 config 快照）为基准 ⇒ 桌面版写进 cordis.patch.yml 的值热刷新不进来'
      : usesRowValue
        ? '基准改成 row.value（当前 patch 解析出的现值），拿不到才退回 config'
        : '没认出这两种写法，需要人读 loadCfg',
    ok: usesSnapshot ? false : usesRowValue ? true : null,
  })

  // B1b pythonPath 是否被列进「本地优先」集合（不再被界面上那个 "python" 压回）。
  const pyLocalWins = /['"]pythonPath['"]\s*[,)\]]/.test(src)
  const hasVenvGuess = /venvGuess/.test(src)
  checks.push({
    id: 'B1b',
    title: 'pythonPath 是否由插件自己说了算（本地优先 / venv 兜底）',
    detail: pyLocalWins || hasVenvGuess
      ? (pyLocalWins ? "pythonPath 在「本地优先」名单里" : '') + (hasVenvGuess ? '，且带 venv 路径兜底' : '')
      : 'pythonPath 没有任何兜底 ⇒ 宿主那份 "python" 会赢，出码 spawn 到商店存根',
    ok: pyLocalWins || hasVenvGuess,
  })

  // B2 写路径：是否把整份内存 cfg 摊回磁盘。
  const wholeWrite = /writeJson\(\s*cfgFile\s*,\s*(\{\s*\.\.\.cfg|cfg)\b/.test(src)
  const hasSetTrace = /_set\s*:/.test(src)
  checks.push({
    id: 'B2',
    title: 'saveCfg 是否把整份内存 cfg 写回磁盘',
    detail: !wholeWrite
      ? '只写 patch 与已有键，不再整份摊出'
      : hasSetTrace
        ? '仍写整份 cfg，但带 `_set` 记录「哪些键由插件面板说了算」⇒ 读路径能挡住陈旧键（部分缓解，不是根治）'
        : '写整份 cfg 且无来源标记 ⇒ 改 A 键会把内存里陈旧的 B/C 键一起写回（缺陷原样）',
    ok: wholeWrite ? (hasSetTrace ? null : false) : true,
  })

  // B3 找 dsh 的策略。缺陷版只有三条硬编码（app.asar.unpacked / app / node_modules），桌面版全落空。
  const hardcoded = /'app\.asar\.unpacked'/.test(src)
  const hasRequire = /createRequire\(/.test(src)
  const hasScan = /scanForDsh/.test(src)
  checks.push({
    id: 'B3',
    title: '找 dsh 的策略：硬编码三条 / 解析器 + 有界递归',
    detail: hasRequire || hasScan
      ? '先问 Node 解析器（@deepseek-ai/dsh/lib/bin.js），再退 npm 全局，最后在应用目录里有界递归' +
        (hardcoded ? '（硬编码三条也在，但已不是唯一出路）' : '')
      : hardcoded
        ? '只有 app.asar.unpacked / app / node_modules 三条硬编码 ⇒ 桌面版都在 app.asar 里，三条全落空 ⇒ 退到 PATH 里的 dsh'
        : '没认出策略，需要人读 findDshCli',
    ok: hasRequire || hasScan ? true : hardcoded ? false : null,
  })

  // B4 overlay 是否重新打开被 headless patch 关掉的三服务。
  const overlayFalse = /disabled:\s*false/.test(src)
  const threeIds = ['credentials', 'authorization', 'deepseek-account'].every((id) => src.includes("'" + id + "'") || src.includes('"' + id + '"'))
  checks.push({
    id: 'B4',
    title: 'headless overlay 是否重开 credentials / authorization / deepseek-account',
    detail: overlayFalse && threeIds
      ? '三个 id 都写了 disabled: false（否则那一轮读不到凭证库里的 key）'
      : '没找到完整的三条重开 ⇒ 那一轮会 MISSING_CREDENTIAL',
    ok: overlayFalse && threeIds,
  })

  // B5 判重表解析：只要「表格行 + 固定列位」就够不够？（#78：seen.md 有一百多条，一条也读不出来）
  const scansForBv = /findIndex\(\s*\(?\s*\w+\s*\)?\s*=>\s*\/\^BV/.test(src)
  const tolerantDay = /seenDay\(/.test(src)
  const countsBad = /bad\s*\+\+|seenBadDays/.test(src)
  checks.push({
    id: 'B5',
    title: '判重表解析：扫描 BV 位置 / 假设固定列位',
    detail: scansForBv
      ? 'BV 用 findIndex 扫描定位' +
        (tolerantDay ? '，日期走 seenDay 宽松解析（带时间 / 省年份都认）' : '') +
        (countsBad ? '，认不出的行会计数并 log' : '') +
        ' ⇒ 章程怎么写都能读出来'
      : '仍假设 BV 固定在某个列位 ⇒ seen.md 的写法一变，面板「它刷过的视频」就恒空（#78 原样）',
    ok: scansForBv ? true : tolerantDay && countsBad ? null : false,
  })

  // B6 POST /config 的白名单：手工数组（漏字段）还是从 DEFAULTS 推导（自动跟上）
  const derivesFromDefaults = /for\s*\(\s*const\s+k\s+of\s+Object\.keys\(DEFAULTS\)\s*\)\s*\{?\s*if\s*\(\s*k\s+in\s+body/.test(src)
  const manualAllow = /const\s+ALLOW[A-Za-z_]*\s*=\s*\[/.test(src)
  const blankGuard = /isBlank\s*\(/.test(src) || /空值保护/.test(src)
  checks.push({
    id: 'B6',
    title: '配置写入通道的白名单：从 DEFAULTS 推导 / 手写数组',
    detail: derivesFromDefaults
      ? '白名单由 Object.keys(DEFAULTS) 推导 ⇒ 新增配置项自动放行' + (blankGuard ? '，且带空值保护（空值不覆盖已有值，清空要显式 clear）' : '')
      : manualAllow
        ? '仍是手写白名单数组 ⇒ 2.x 新增字段会被静默过滤，保存后又被轮询弹回（#79 原样）'
        : '没认出白名单写法，需要人读 POST /api/bili-duty/config',
    ok: derivesFromDefaults ? true : manualAllow ? false : null,
  })

  // B7 计数口径：reportLevel=off 时数什么？（#80：没有报告可数 ⇒ 恒 0 ⇒ perDay 闸门失效）
  const cpBody = fnBody(src, 'countPickedToday')
  const seenWhenOff = cpBody ? /reportLevel[^\n]*['"]off['"]/.test(cpBody) && /parseSeenTable\s*\(/.test(cpBody) : null
  checks.push({
    id: 'B7',
    title: 'reportLevel=off 时的当日计数来源',
    detail: seenWhenOff === true
      ? '「不写日报」档会退一步去 seen.md 数当天挑中的行 ⇒ perDay 闸门仍然成立'
      : seenWhenOff === false
        ? '只数报告文件 ⇒ 不写日报时恒 0 ⇒ perDay 闸门失效，一天能挑到上限的两倍（#80 原样）'
        : '找不到 countPickedToday，需要人读',
    ok: seenWhenOff,
  })
  const hasManualExtra = /manualExtra/.test(src)
  checks.push({
    id: 'B7b',
    title: '手动轮是否按「额外的一次」单独记账（参照项）',
    detail: hasManualExtra
      ? '有 manualExtra ⇒ 自动额度只扣自动轮挑的，手动轮不会被算成超额度'
      : '没有 manualExtra ⇒ 手动轮挑的会挤占当天自动额度（#80 的附带问题）',
    ok: null,
  })

  const judged = checks.filter((c) => c.ok !== null)
  const passed = judged.filter((c) => c.ok).length
  const failed = judged.filter((c) => c.ok === false).length
  const verdict = !judged.length
    ? { code: 'UNKNOWN', label: '判定器没认出任何一条，需要人读源码' }
    : failed === 0
      ? { code: 'FIXED', label: '所有结论项都过了（标 · 的是参照项：单看它会误判，必须配合结论项）' }
      : passed === 0
        ? { code: 'DEFECT', label: '全部结论项都能在源码里对上 ⇒ 装完直接用不了' }
        : { code: 'PARTIAL', label: `还有 ${failed} 条没修（见 ❌ 项）` }
  return { checks, verdict, judged, passed, failed }
}

/* ------------------------------------------------------------------ 自检 */
const FIXTURE = {
  buggy: [
    'const hostCfg = () => normalize(config, { ...DEFAULTS })',
    'const loadCfg = () => {',
    '  const saved = savedCfg(); const row = settingsDesc()',
    '  if (!row) return clampPatch(saved)',
    '  const user = row.user || {}',
    '  const out = { ...hostCfg() }',
    '  for (const k of Object.keys(DEFAULTS)) if (user[k] === undefined) out[k] = saved[k]',
    '  return clampPatch(out)',
    '}',
    'const saveCfg = (patch) => { Object.assign(cfg, normalize(patch, cfg)); writeJson(cfgFile, cfg) }',
    "// #78 判重表：固定列位取 BV，日期不宽松，坏行静默丢",
    "for (const line of text.split('\\n')) {",
    "  if (!line.startsWith('|')) continue",
    "  const cells = line.split('|').map((x) => x.trim())",
    "  if (cells.length < 4) continue",
    "  const bvid = cells[1]; const day = cells[2]; const status = cells[3]",
    "  out.push({ day, bvid, status })",
    "}",
    "// #79 白名单是手写的固定数组，2.x 新增字段进不来",
    "const ALLOW = ['perDay', 'peakValley', 'noon', 'night', 'keywords']",
    "const patch = {}; for (const k of ALLOW) { if (k in body) patch[k] = body[k] }",
    "// #80 只数报告文件：不写日报时恒 0",
    "const countPickedToday = (now = new Date()) => {",
    "  const st = readJson(dutyStateFile, {})",
    "  const fromState = st.day === dayKey(now) ? Number(st.picked || 0) : 0",
    "  return Math.max(fromState, countPicks(reportFileOf(now)))",
    "}",
    "const roots = process.resourcesPath ? [",
    "  ['app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],",
    "  ['app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],",
    "  ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],",
    '] : []',
  ].join('\n'),
  fixed: [
    'const hostCfg = () => normalize(config, { ...DEFAULTS })',
    'const loadCfg = () => {',
    '  const saved = savedCfg()',
    '  const row = settingsDesc()',
    '  const out = normalize(row.value && typeof row.value === "object" ? row.value : config, { ...DEFAULTS })',
    "  const touched = new Set([...touchedKeys, 'pythonPath'])",
    '  for (const k of Object.keys(DEFAULTS)) { if (touched.has(k)) { out[k] = saved[k]; continue } }',
    '  return clampPatch(out)',
    '}',
    'const saveCfg = (patch) => { Object.assign(cfg, normalize(patch, cfg)); writeJson(cfgFile, { ...cfg, _set: [...touchedKeys] }) }',
    "const findDshCli = () => { const req = createRequire(import.meta.url); scanForDsh(process.resourcesPath, 0, { n: 0 }) }",
    "for (const id of ['credentials', 'authorization', 'deepseek-account']) yml.push('- id: ' + id, '  disabled: false', '')",
    "// #78 修好形：BV 扫描定位 + 日期宽松 + 坏行计数",
    "for (const raw of text.split('\\n')) {",
    "  const line = raw.trim()",
    "  if (!line.startsWith('|')) continue",
    "  const cells = line.split('|').map((x) => x.trim())",
    "  const c = cells.slice(1, cells.length - 1)",
    "  const bvIdx = c.findIndex((x) => /^BV[0-9A-Za-z]{10}$/.test(x))",
    "  if (bvIdx < 0) continue",
    "  const day = seenDay(c[bvIdx - 1])",
    "  if (!day) { bad++; continue }",
    "}",
    "if (bad !== seenBadDays) { seenBadDays = bad; log('判重表有 ' + bad + ' 行日期认不出来') }",
    "// #79 修好形：白名单从 DEFAULTS 推导 + 空值保护",
    "const patch = {}; for (const k of Object.keys(DEFAULTS)) { if (k in body) patch[k] = body[k] }",
    "const clears = Array.isArray(body && body.clear) ? body.clear : []",
    "const isBlank = (v) => v === '' || (Array.isArray(v) && v.length === 0)",
    "// #80 修好形：不写日报时回退数 seen.md；手动轮单独记账",
    "const countPickedToday = (now = new Date()) => {",
    "  const st = readJson(dutyStateFile, {})",
    "  const fromState = st.day === dayKey(now) ? Number(st.picked || 0) : 0",
    "  let fromSeen = 0",
    "  if (String(cfg.reportLevel || 'full') === 'off') {",
    "    fromSeen = parseSeenTable().filter((r) => r.day === today && r.picked).length",
    "  }",
    "  return Math.max(fromState, countPicks(reportFileOf(now)), fromSeen)",
    "}",
    "const autoPickedToday = (now) => Math.max(0, countPickedToday(now) - Number(readJson(dutyStateFile, {}).manualExtra || 0))",
  ].join('\n'),
}

function selftest() {
  const buggy = auditSources(FIXTURE.buggy)
  const fixed = auditSources(FIXTURE.fixed)
  const cases = [
    ['缺陷版（报告里那段代码的形状）', buggy.verdict.code, 'DEFECT'],
    ['修复版（row.value + 有界递归 + overlay 重开）', fixed.verdict.code, 'FIXED'],
  ]
  // 逐条断言：只看总判可能被「别处凑巧通过」骗过去，所以每条结论项都要正反两面都对
  const byId = (r, id) => (r.checks.find((c) => c.id === id) || {}).ok
  for (const id of ['B1', 'B1b', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7']) {
    cases.push([`缺陷版 ${id} 判不通过`, byId(buggy, id), false])
  }
  // B2 是参照项：2.5.0 写回仍带整份 cfg，只是多了 _set 来源标记 ⇒ 修好版也该是 ·（null）
  for (const id of ['B1', 'B1b', 'B3', 'B4', 'B5', 'B6', 'B7']) {
    cases.push([`修复版 ${id} 判通过`, byId(fixed, id), true])
  }
  cases.push(['修复版 B2 仍是参照项（·）', byId(fixed, 'B2'), null])
  let bad = 0
  console.log('自检：判定器对两份合成源码的结论（能分辨才算数）\n')
  for (const [name, got, want] of cases) {
    const ok = got === want
    if (!ok) bad++
    console.log(`  ${ok ? '✅' : '❌'} ${name} → ${got}（期望 ${want}）`)
  }
  console.log('\n逐条明细：')
  for (const [label, r] of [['缺陷版', buggy], ['修复版', fixed]]) {
    console.log(`  ${label}：`)
    for (const c of r.checks) console.log(`    ${c.ok === null ? '·' : c.ok ? '✅' : '❌'} [${c.id}] ${c.title}`)
  }
  console.log('')
  if (bad) {
    console.error(`自检失败 ${bad} 项：判定器不可信，别用它下结论。`)
    process.exit(1)
  }
  console.log('自检通过。')
}

/* ------------------------------------------------------------------ 现场：三方配置对照 */
/**
 * 极简 cordis.patch.yml 片段解析：只认 `name: <插件>` 之后那层 `config:` 下的**标量键**。
 * 块标量（| / |- / > / >-）与嵌套对象只记占位，不参与数值比较 —— 够用来抓「改一个冲掉一片」。
 */
function parsePatchConfig(text, name) {
  if (!text) return null
  const lines = text.split(/\r?\n/)
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const nameRe = new RegExp('^\\s*-?\\s*name:\\s*["\']?' + esc + '["\']?\\s*$')
  const idx = lines.findIndex((l) => nameRe.test(l))
  if (idx < 0) return null
  let i = idx + 1
  while (i < lines.length && !/^\s*config:\s*$/.test(lines[i]) && !/^\s*-?\s*name:/.test(lines[i])) i++
  if (i >= lines.length || !/^\s*config:\s*$/.test(lines[i])) return null
  const baseIndent = (lines[i].match(/^(\s*)/) || ['', ''])[1].length
  const keyIndent = baseIndent + 2
  const out = {}
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j]
    if (!line.trim()) continue
    const ind = (line.match(/^(\s*)/) || ['', ''])[1].length
    if (ind <= baseIndent) break
    const m = /^(\s*)([A-Za-z0-9_$]+):\s*(.*)$/.exec(line)
    if (!m || m[1].length !== keyIndent) continue
    const key = m[2]
    const val = m[3].trim()
    if (/^[|>][+-]?$/.test(val)) { out[key] = { block: true }; continue }
    if (val === '') { out[key] = { object: true }; continue }
    out[key] = val.replace(/^["']|["']$/g, '')
  }
  return out
}

const norm = (v) => {
  if (v === undefined) return undefined
  if (v === null) return 'null'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function tripleTable(cfgJson, patchCfg, override) {
  const keys = ['perDay', 'peakValley', 'autoComment', 'dmMode', 'pythonPath', 'workspace', 'replyToComments']
  const rows = []
  for (const k of keys) {
    const a = cfgJson ? cfgJson[k] : undefined
    const b = patchCfg ? (patchCfg[k] && (patchCfg[k].block || patchCfg[k].object) ? undefined : patchCfg[k]) : undefined
    const o = override && override[k] !== undefined ? `插件面板刚存（${new Date(override[k]).toISOString().slice(0, 19)}Z）` : ''
    const both = a !== undefined && b !== undefined
    const clash = both && norm(a) !== norm(b)
    rows.push({ key: k, configJson: norm(a), hostPatch: norm(b), localOverride: o, clash })
  }
  return rows
}

/* ------------------------------------------------------------------ 现场：pythonPath 探路 */
function pythonProbe(cfgJson) {
  const py = cfgJson && typeof cfgJson.pythonPath === 'string' ? cfgJson.pythonPath : ''
  const venvWin = path.join(STATE, '.venv', 'Scripts', 'python.exe')
  const venvPosix = path.join(STATE, '.venv', 'bin', 'python')
  const venv = exists(venvWin) ? venvWin : exists(venvPosix) ? venvPosix : ''
  const verdict = !py
    ? { code: 'EMPTY', label: 'config.json 里没有 pythonPath' }
    : py === 'python'
      ? { code: 'STORESHELL', label: 'pythonPath 就是裸 "python" ⇒ Windows 上会 spawn 到微软商店存根（exit 9009），出码静默失败' }
      : exists(py)
        ? { code: 'OK', label: 'pythonPath 指向一个真实存在的解释器' }
        : { code: 'MISSING', label: 'pythonPath 指向的路径不存在' }
  return { pythonPath: py, venv, venvExists: Boolean(venv), verdict }
}

/* ------------------------------------------------------------------ 输出 */
function main() {
  if (has('selftest')) return selftest()

  const pkg = readJson(path.join(PLUGIN, 'package.json')) || {}
  const indexSrc = readIf(path.join(PLUGIN, 'index.js')) || ''
  const srcAudit = indexSrc
    ? auditSources(indexSrc)
    : { checks: [], verdict: { code: 'UNKNOWN', label: '读不到 <插件目录>/index.js（--plugin 给错了？）' }, judged: [], passed: 0, failed: 0 }
  const cfgJson = readJson(path.join(STATE, 'config.json'))
  const override = readJson(path.join(STATE, 'local-override.json')) || {}
  const patchText = readIf(PATCH)
  const patchCfg = parsePatchConfig(patchText, PKG_NAME)
  const rows = tripleTable(cfgJson, patchCfg, override)
  const py = pythonProbe(cfgJson)

  if (JSON_OUT) {
    console.log(JSON.stringify({
      plugin: PLUGIN,
      version: pkg.version || '?',
      source: srcAudit,
      configJson: cfgJson ? '<见 tripleTable>' : null,
      patch: PATCH,
      patchFound: Boolean(patchText),
      patchConfig: patchCfg,
      triple: rows,
      python: py,
    }, null, 2))
    return
  }

  console.log('dsh-bili-scroll · 桌面版三处 bug 是否还在  只读审计')
  console.log('='.repeat(72))
  console.log(`插件目录：${PLUGIN}`)
  console.log(`版本：${pkg.version || '?'}${pkg.version ? '' : '（读不到 package.json）'}`)
  console.log(`状态目录：${STATE}`)
  console.log(`宿主 patch：${PATCH}${patchText ? '' : '  ← 读不到'}`)

  console.log('\n一、源码：三条 bug 对应的代码路径')
  if (!srcAudit.checks.length) {
    console.log('  ' + srcAudit.verdict.label)
  } else {
    for (const c of srcAudit.checks) {
      console.log(`  ${c.ok === null ? '·' : c.ok ? '✅' : '❌'} [${c.id}] ${c.title}`)
      console.log(`      ${c.detail}`)
    }
    console.log(`  小计：${srcAudit.passed}/${srcAudit.judged.length} 项通过`)
    console.log(`  结论：${srcAudit.verdict.code} —— ${srcAudit.verdict.label}`)
  }

  console.log('\n二、现场：三方值是否还打架（Bug 2 的用户可见症状）')
  if (!cfgJson) {
    console.log(`  读不到 ${path.join(STATE, 'config.json')} ⇒ 跳过`)
  } else if (!patchCfg) {
    console.log('  宿主 patch 里没有这个插件的 config 段 ⇒ 只列插件自己那份：')
    for (const r of rows) if (r.configJson !== undefined) console.log(`    ${r.key} = ${r.configJson}`)
  } else {
    // 长值从**左边**省略：路径的关键信息在尾部（venv\Scripts\python.exe）；每格末尾留一个空格当分隔
    const pad = (s, n) => {
      const v = String(s === undefined ? '—' : s)
      const t = v.length > n - 1 ? '…' + v.slice(-(n - 2)) : v
      return t.padEnd(n - 1) + ' '
    }
    console.log('  ' + pad('键', 18) + pad('插件 config.json', 34) + pad('宿主 cordis.patch', 34) + '备注')
    let clashCount = 0
    for (const r of rows) {
      if (r.clash) clashCount++
      const note = r.clash ? '⚠️ 两边不一样' : r.localOverride ? r.localOverride : ''
      console.log('  ' + pad(r.key, 18) + pad(r.configJson, 34) + pad(r.hostPatch, 34) + note)
    }    console.log('')
    console.log(clashCount
      ? `  ⚠️ ${clashCount} 个键两边不一样。桌面版里这不一定都是 bug（插件面板管的键本来就该压过宿主），`
        + '\n     但「改一个键、另一个键跟着变」正是写整份 cfg 那处的症状：对照 _set / local-override 能否解释。'
      : '  两边一致。')
    const setKeys = Array.isArray(cfgJson._set) ? cfgJson._set : []
    if (setKeys.length) console.log(`  config.json 里 _set 记了 ${setKeys.length} 个「插件面板说了算」的键`)
    const ovKeys = Object.keys(override)
    if (ovKeys.length) console.log(`  local-override.json 记了 ${ovKeys.length} 个「本地刚存、宿主没同步成功」的键：${ovKeys.join(', ')}`)
  }

  console.log('\n三、pythonPath 探路（Bug 1 的落地形态）')
  console.log(`  config.json 里的 pythonPath：${py.pythonPath || '（空）'}`)
  console.log(`  venv 实际路径：${py.venv || '（状态目录下没有 .venv）'}`)
  console.log(`  结论：${py.verdict.code} —— ${py.verdict.label}`)
  if (py.verdict.code === 'STORESHELL') {
    console.log('  修法：把它指到上面那行 venv 路径（或让插件自己算出来，见报告 Bug 1 的最小改法）。')
  }

  console.log('\n四、还能怎么自己核（不用信任本脚本）')
  console.log('  · 出码时看 duty.log 里 spawn 的 python 是哪个：`grep -n "spawn → python" duty.log`')
  console.log('  · 跑一轮前确认 dsh 能找到：设置页「自检」那行会给 resolveDsh() 的返回')
  console.log('  · local-override.json 里有键 ⇒ 说明宿主那次 settings.update 没写进去（桌面版 profile reload 限制）')
  console.log('')
}

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''))
  process.exit(0)
}

try {
  main()
} catch (e) {
  console.error('审计脚本自身出错：' + (e && e.stack ? e.stack : e))
  process.exit(2)
}
