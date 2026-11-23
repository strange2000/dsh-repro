#!/usr/bin/env node
'use strict'
/**
 * 只读审计：skin-center 冷启动时样式表请求超出 CSS 安全管线的 10s 预算 → 500，boot 不重试 → 落回官方默认。
 *
 * 背景见 ../reports/0007-skin-center-coldstart-fallback.md。一句话：
 *   皮肤 CSS 不直接下发，要先过 lightningcss 白名单转换（每请求 fork 一个短命 worker）。冷启动首次请求
 *   实测 14.59s > SKIN_CSS_REQUEST_TIMEOUT_MS(10000) ⇒ 500 css-transform-failed ⇒ 渲染端 bootSkinRuntime()
 *   的 catch 只做一次 adopt(null, null) ⇒ removeAttribute('data-dsh-skin') ⇒ 官方默认。
 *   用户看到的是「每次重启皮肤都没了」，而 ~/.dsh/skin-center-active.json 里的选择一直没丢。
 *
 * 本脚本不启动 DSH、不执行插件代码、不写盘、默认不联网：只读源码 + 只读宿主日志 + 只读 active 文件。
 *
 * 用法：
 *   node audit-coldstart.cjs                    # 自动扫 ~/.dsh/profiles/<profile>/node_modules/@linxin666/dsh-client-ui-skin-center
 *   node audit-coldstart.cjs --dir <插件目录>
 *   node audit-coldstart.cjs --logs <日志目录>   # 默认 ~/.dsh/logs
 *   node audit-coldstart.cjs --active <文件>     # 默认 ~/.dsh/skin-center-active.json
 *   node audit-coldstart.cjs --probe [url]      # 额外实测一次 stylesheet 延迟（会联网打到本机 GUI，仅此一项）
 *   node audit-coldstart.cjs --json
 *   node audit-coldstart.cjs --selftest         # 用缺陷形状/修复形状的合成源码验证判定器本身（离线）
 *
 * 退出码：0 = 审计跑完（**缺陷有无不体现在退出码上**，别当 CI 门禁）；2 = 参数/环境错误。
 */

const fs = require('node:fs')
const path = require('node:path')

const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)
const flag = (n) => {
  const i = argv.indexOf('--' + n)
  if (i === -1) return null
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}
const HOME = process.env.USERPROFILE || process.env.HOME || ''
const JSON_OUT = has('json')
const BUDGET_MITIGATED_MS = 30000

/* ------------------------------------------------------------------ 判定器 */
/** 从 SKIN_CSS_REQUEST_TIMEOUT_MS 的赋值里取毫秒数（支持 1e4 / 10000 / 10_000）；找不到返回 null。 */
function parseBudgetMs(src) {
  const m = src.match(/SKIN_CSS_REQUEST_TIMEOUT_MS\s*=\s*([0-9][0-9e_\.\+]*)/i)
  if (!m) return null
  const raw = m[1].replace(/_/g, '')
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

/** 取 bootSkinRuntime 的函数体（找不到就退化为整份源码）。 */
function bootBody(src) {
  const i = src.search(/function\s+bootSkinRuntime|bootSkinRuntime\s*=\s*(async\s*)?\(/)
  if (i === -1) return src
  const rest = src.slice(i)
  const end = rest.slice(1).search(/\nasync function |\nfunction /)
  return end === -1 ? rest : rest.slice(0, end + 1)
}

/**
 * 结论项 A：启动失败路径上有没有重试。
 * 判据：落默认的 adopt(null, null) 之前 600 字符内出现循环 / 退避 / 重试迹象 ⇒ 有重试。
 * 只抓「落默认之前」这一小段，避免把 catalog 遍历之类的无关 for 循环算进来。
 */
function checkBootRetry(clientSrc) {
  const body = bootBody(clientSrc)
  const k = body.indexOf('adopt(null, null)')
  if (k === -1) return { ok: null, note: '源码里没找到 adopt(null, null)，无法判定（版本差异？）' }
  const win = body.slice(Math.max(0, k - 600), k)
  const hit = win.match(/\b(for|while)\s*\(|retry|backoff|attempt|setTimeout|\bsleep\b/i)
  return hit
    ? { ok: true, note: '落默认前出现重试/退避迹象：' + hit[0] }
    : { ok: false, note: '落默认前无循环/退避/重试：一次性 adopt 失败即清皮肤' }
}

/** 结论项 B：超时预算是否放宽（或存在 worker 预热），即失败是否已被「绕开」。 */
function checkBudget(indexSrc) {
  const ms = parseBudgetMs(indexSrc)
  const warm = /prewarm|warm[\s-]?up/i.test(indexSrc)
  if (ms === null && !warm) return { ok: false, ms: null, note: '既没解析到超时预算，也没有预热迹象' }
  if (warm) return { ok: true, ms, note: '存在 worker 预热（' + (ms ? ms + 'ms 预算' : '预算未解析') + '）' }
  return {
    ok: ms >= BUDGET_MITIGATED_MS,
    ms,
    note: ms >= BUDGET_MITIGATED_MS
      ? '预算已放宽到 ' + ms + 'ms'
      : '预算仍是 ' + ms + 'ms（冷启动首请求实测 14.59s 打不住）',
  }
}

/** 参照项 C：宿主日志里的现场证据。 */
function scanLogs(text) {
  const out = { failed: 0, switches: 0, dates: [], samples: [] }
  for (const line of text.split('\n')) {
    if (!line) continue
    if (/stylesheet load failed/i.test(line)) {
      out.failed++
      if (out.samples.length < 3) out.samples.push(line.trim().slice(0, 200))
      const d = line.match(/(\d{4}-\d{2}-\d{2})T/)
      if (d && !out.dates.includes(d[1])) out.dates.push(d[1])
    }
    if (/previous skin intact/i.test(line)) out.switches++
  }
  return out
}

/** 参照项 D：选择有没有丢（active 非 null 而现场落默认 ⇒ 不是持久化问题）。 */
function checkActive(text) {
  try {
    const j = JSON.parse(text)
    return { ok: typeof j.active === 'string' && j.active.length > 0, active: j.active ?? null, initialized: j.initialized ?? null }
  } catch {
    return { ok: null, note: 'active 文件不是合法 JSON' }
  }
}

/* ------------------------------------------------------------------ selftest */
function selftest() {
  const defectClient = [
    'async function bootSkinRuntime(controller, entry, active) {',
    '  await refreshCatalog()',
    '  try { await controller.adopt(active, entry) } catch (e) {',
    "    console.warn('[skin-center] switch to', active, 'failed; previous skin intact')",
    '    await controller.adopt(null, null).catch(() => {})',
    '  }',
    '}',
  ].join('\n')
  const fixedClient = [
    'async function bootSkinRuntime(controller, entry, active) {',
    '  await refreshCatalog()',
    '  for (let attempt = 0; attempt < 3; attempt++) {',
    '    try { await controller.adopt(active, entry); return }',
    '    catch (e) { lastErr = e; await sleep(1000 * Math.pow(3, attempt)) }',
    '  }',
    '  await controller.adopt(null, null).catch(() => {})',
    '}',
  ].join('\n')
  const defectIndex = 'const SKIN_CSS_REQUEST_TIMEOUT_MS = 1e4\nconst SKIN_CSS_MAX_OUTSTANDING = 8'
  const fixedIndex = 'const SKIN_CSS_REQUEST_TIMEOUT_MS = 6e4'
  const fakeLog = JSON.stringify({ t: '2026-11-23T06:53:12.678Z', msg: 'Error: stylesheet load failed: api/skin-center/v2/skins/tight-sidebar/stylesheet' })

  const cases = [
    ['A 缺陷形状 ⇒ 无重试', checkBootRetry(defectClient).ok, false],
    ['A 修复形状 ⇒ 有重试', checkBootRetry(fixedClient).ok, true],
    ['B 缺陷形状 ⇒ 预算 10000', checkBudget(defectIndex).ms, 10000],
    ['B 修复形状 ⇒ 预算 60000 且判为放宽', checkBudget(fixedIndex).ok, true],
    ['C 日志扫描 ⇒ 数到 1 条', scanLogs(fakeLog).failed, 1],
    ['D active 解析', checkActive('{"active":"tight-sidebar","initialized":true}').ok, true],
  ]
  let bad = 0
  for (const c of cases) {
    const name = c[0], got = c[1], want = c[2]
    const ok = got === want
    if (!ok) bad++
    console.log((ok ? '  ✅ ' : '  ❌ ') + name + (ok ? '' : '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)))
  }
  console.log(bad === 0 ? 'selftest: 6/6 通过（判定器分得开缺陷形状与修复形状）' : 'selftest: ' + bad + ' 项失败')
  return bad === 0 ? 0 : 1
}

if (has('selftest')) process.exit(selftest())

/* ------------------------------------------------------------------ 真机审计 */
function readIf(p) {
  try { return fs.readFileSync(p, 'utf8') } catch { return null }
}

function discover() {
  const roots = []
  const explicit = flag('dir')
  if (typeof explicit === 'string') roots.push(explicit)
  else {
    const profiles = path.join(HOME, '.dsh', 'profiles')
    let names = []
    try { names = fs.readdirSync(profiles) } catch { names = [] }
    for (const n of names) roots.push(path.join(profiles, n, 'node_modules', '@linxin666', 'dsh-client-ui-skin-center'))
    roots.push(path.join(HOME, '.dsh', 'node_modules', '@linxin666', 'dsh-client-ui-skin-center'))
  }
  return roots.filter((p) => fs.existsSync(path.join(p, 'lib', 'client.js')) || fs.existsSync(path.join(p, 'lib', 'index.js')))
}

const logDirFlag = flag('logs')
const logDir = typeof logDirFlag === 'string' ? logDirFlag : path.join(HOME, '.dsh', 'logs')
const activeFlag = flag('active')
const activePath = typeof activeFlag === 'string' ? activeFlag : path.join(HOME, '.dsh', 'skin-center-active.json')
const dirs = discover()
if (!dirs.length) {
  console.error('没有找到 skin-center 安装（可用 --dir 指定插件目录）')
  process.exit(2)
}

const results = []
for (const dir of dirs) {
  const client = readIf(path.join(dir, 'lib', 'client.js')) || ''
  const index = readIf(path.join(dir, 'lib', 'index.js')) || ''
  const pkg = readIf(path.join(dir, 'package.json')) || ''
  const version = (pkg.match(/"version"\s*:\s*"([^"]+)"/) || [])[1] || '?'
  const a = checkBootRetry(client)
  const b = checkBudget(index)
  const verdict = a.ok === true ? 'FIXED' : b.ok ? 'PARTIAL' : 'DEFECT'
  results.push({ dir, version, a, b, verdict })
}

let logStats = { failed: 0, switches: 0, dates: [], samples: [] }
let logFiles = []
try {
  logFiles = fs.readdirSync(logDir).filter((f) => /\.jsonl$/i.test(f)).sort()
} catch { logFiles = [] }
for (const f of logFiles) {
  const txt = readIf(path.join(logDir, f))
  if (!txt) continue
  const s = scanLogs(txt)
  logStats.failed += s.failed
  logStats.switches += s.switches
  for (const d of s.dates) if (!logStats.dates.includes(d)) logStats.dates.push(d)
  if (logStats.samples.length < 3) logStats.samples.push(...s.samples.slice(0, 3 - logStats.samples.length))
}
logStats.dates.sort()
const activeRaw = readIf(activePath)
const activeState = activeRaw === null ? { ok: null, note: '没有 active 文件（' + activePath + '）' } : checkActive(activeRaw)

async function probe() {
  const arg = flag('probe')
  const base = typeof arg === 'string' ? arg : 'http://127.0.0.1:48611'
  const skin = activeState && activeState.active
  if (!skin) return { skipped: '当前 active 为空（用户已切回官方默认），没有可实测的皮肤' }
  const url = base.replace(/\/$/, '') + '/api/skin-center/v2/skins/' + encodeURIComponent(skin) + '/stylesheet'
  const t0 = Date.now()
  try {
    const res = await fetch(url)
    const body = await res.text()
    const ms = Date.now() - t0
    return { url, status: res.status, ms, overBudget: ms > (results[0].b.ms || 10000), head: body.slice(0, 120) }
  } catch (e) {
    return { url, error: String((e && e.message) || e).slice(0, 160) }
  }
}

;(async () => {
  const probed = has('probe') ? await probe() : null
  if (JSON_OUT) {
    console.log(JSON.stringify({ dirs: results, logs: Object.assign({ dir: logDir, files: logFiles.length }, logStats), active: Object.assign({ path: activePath }, activeState), probe: probed }, null, 2))
    return
  }
  console.log('皮肤中心冷启动回退 · 只读审计')
  for (const r of results) {
    console.log('')
    console.log('插件目录：' + r.dir)
    console.log('版本：' + r.version)
    console.log('  ' + (r.a.ok === true ? '✅' : r.a.ok === null ? '·' : '❌') + ' [A] ' + r.a.note)
    console.log('  ' + (r.b.ok ? '✅' : '❌') + ' [B] ' + r.b.note)
    console.log('  结论：' + r.verdict + (r.verdict === 'PARTIAL' ? '（超时被绕开，但一次性失败仍会落默认）' : ''))
  }
  console.log('')
  console.log('宿主日志：' + logDir + '（' + logFiles.length + ' 个 .jsonl）')
  console.log('  ' + (logStats.failed ? '❌' : '✅') + ' [C] stylesheet load failed ×' + logStats.failed + '，switch failed ×' + logStats.switches + (logStats.dates.length ? '，日期：' + logStats.dates.join(' / ') : ''))
  for (const s of logStats.samples) console.log('        ' + s)
  console.log('  ' + (activeState.ok === null ? '·' : activeState.ok ? '✅' : '❌') + ' [D] active=' + JSON.stringify(activeState.active) + '（initialized=' + JSON.stringify(activeState.initialized) + '）' + (activeState.ok ? ' —— 选择没丢，是运行期拉取失败' : ''))
  if (probed) {
    console.log('')
    console.log('实测探针：' + (probed.skipped ? '跳过 —— ' + probed.skipped : probed.error ? '失败 —— ' + probed.error : probed.url + ' → HTTP ' + probed.status + ' / ' + probed.ms + 'ms' + (probed.overBudget ? '（超出预算）' : '')))
  }
  console.log('')
  console.log('说明：[C] 是参照项（读的是历史日志），结论只由 [A] 决定、[B] 判断是否被绕开。')
  console.log('脚本不改任何文件、不改配置；--probe 是唯一会联网的选项，且只打本机 GUI。')
})()
