#!/usr/bin/env node
'use strict'
/**
 * 只读审计：dsh-our-free-model 的「应用内升级」在热重载失败时，是**延迟激活**还是**回滚整次升级**。
 *
 * 背景见 ../reports/0002-dsh-our-free-model.md。一句话：
 *   桌面版宿主暴露不出可枚举的 ESM 缓存 ⇒ purgeCaches 拿到 0 个模块 ⇒ 兜底的 re-import 又命中
 *   已求值的缓存（loader 用 resolved path 做 key，query 被规范化掉）⇒ 版本号仍是旧的 ⇒
 *   `activation version mismatch` → throw → updater 调 restoreBackup()，把一份**已经装好并逐字节
 *   校验通过**的升级撤回去。用户看到的是「每次都升级失败」，`diskRestored: true` 是判据。
 *
 * 本脚本不升级、不写插件目录、不联网：只读源码、只读 upgrade-state.json、可选只读宿主日志。
 *
 * 用法：
 *   node audit-activation.cjs                    # 自动扫 ~/.dsh/profiles/* /node_modules/dsh-our-free-model
 *   node audit-activation.cjs --dir <插件目录>    # 指定一份
 *   node audit-activation.cjs --state <目录>      # 默认 ~/.dsh/our-free-model
 *   node audit-activation.cjs --logs             # 顺便统计宿主日志里的证据行（找不到日志就跳过）
 *   node audit-activation.cjs --json
 *   node audit-activation.cjs --selftest         # 用两份合成源码验证判定器本身（离线可跑）
 *
 * 退出码：0 = 审计跑完（**缺陷有无不体现在退出码上**，别拿去当 CI 门禁）；2 = 参数/环境错误。
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

/* ------------------------------------------------------------------ 判定器 */
/**
 * 只在源码文本上做判定 —— 不执行插件代码，所以对任何版本都安全。
 * 返回的 checks[].ok 为 null 表示「仅供参照，不参与结论」。
 */
function auditSources(reloadSrc, updaterSrc) {
  const checks = []

  // A：空缓存分支。缺陷版这里只往 globalThis 塞一个没人读的诊断标记（报告 Minor 段），然后继续往
  //    下走；修好之后这里直接 return { restartRequired: true } 收手。
  const aMatch = /backup\.esm\.size\s*===?\s*0[^\n]*\n([\s\S]{0,900})/.exec(reloadSrc)
  const aBody = aMatch ? aMatch[1] : ''
  const aDefer = /restartRequired\s*:\s*true/.test(aBody)
  const aMarkerOnly = /globalThis\s*\[/.test(aBody) && !aDefer
  checks.push({
    id: 'A',
    title: '宿主导不出 ESM 缓存时，是否优雅降级为「已写入，重启生效」',
    detail: !aMatch
      ? '没找到 backup.esm.size === 0 这个分支（源码结构已变，看 B/C 与状态文件）'
      : aDefer
        ? '该分支 return { restartRequired: true } —— 不再往下 re-import'
        : aMarkerOnly
          ? '该分支只写了一个没人读的 globalThis 标记，然后继续往下 re-import（缺陷原样）'
          : '该分支既没降级也没留标记',
    ok: aMatch ? aDefer : null,
  })

  // B：版本不匹配断言。修好之后这行通常还在，只是桌面版永远走不到（A 已经先返回），
  //    所以只作参照 —— 单看它会把已修版本误判成未修。
  const mismatch = /activation version mismatch/.test(reloadSrc)
  const mismatchThrows = /throw new Error\(`?\s*'?activation version mismatch/.test(reloadSrc)
    || /throw new Error\(`activation version mismatch/.test(reloadSrc)
  checks.push({
    id: 'B',
    title: '版本不匹配断言是否存在、是否 throw',
    detail: !mismatch
      ? '源码里没有 activation version mismatch'
      : mismatchThrows
        ? 'throw 仍在（正常：A 已先拦住，走不到这里）'
        : '提到但没有 throw',
    ok: null,
  })

  // C：updater 侧是否认识 restartRequired。认识才谈得上「装完就完事、重启激活」。
  const cRestart = /restartRequired/.test(updaterSrc)
  checks.push({
    id: 'C',
    title: 'updater 侧是否认识 restartRequired（延迟激活落地）',
    detail: cRestart
      ? 'updater 里出现 restartRequired 字段/标记'
      : 'updater 里完全没有 restartRequired ⇒ 热重载一失败就只能 restoreBackup()',
    ok: cRestart,
  })

  // D：activate 是否为可选参数（报告里 updater.js:977 的 `if (activate !== undefined)`）。
  const cOptional = /activate\s*!==\s*undefined/.test(updaterSrc)
  checks.push({
    id: 'D',
    title: 'apply({ activate }) 的 activate 是否仍然可选',
    detail: cOptional
      ? '是：省略 activate 是受支持路径（这条路本来就能装成功、重启生效）'
      : '没看到 activate !== undefined 的判据（可能改了写法，需人读）',
    ok: null,
  })

  const judged = checks.filter((c) => c.ok !== null)
  const passed = judged.filter((c) => c.ok).length
  let verdict
  if (judged.length && passed === judged.length) {
    verdict = {
      code: 'FIXED',
      label: '延迟激活已落地：热重载不可用 ⇒ 标记 restartRequired，不再回滚整次升级',
    }
  } else if (passed > 0) {
    verdict = { code: 'PARTIAL', label: '只修了一半：见上面未通过的项' }
  } else {
    verdict = {
      code: 'DEFECT',
      label: '仍会回滚：热重载失败 ⇒ throw ⇒ restoreBackup()，已装好并校验通过的升级被撤掉',
    }
  }
  return { checks, verdict, judged, passed }
}

/* ------------------------------------------------------------------ 自检 */
const FIXTURE = {
  buggy: {
    reload: [
      'const internal = loader.internal',
      'const backup = purgeCaches(internal, packageUrl)',
      'if (backup.esm.size === 0) {',
      "  globalThis[Symbol.for('our-free-model.host-cache-unavailable')] = true",
      '}',
      "logger.info?.(`our-free-model: hot reload purging ${backup.esm.size} cached module(s)`)",
      'let replacement',
      'try {',
      '  replacement = await importFresh(entryUrl)',
      "  if (options.expectedVersion !== undefined && replacement.version !== options.expectedVersion) {",
      '    throw new Error(`activation version mismatch: expected ${options.expectedVersion}`)',
      '  }',
      '} catch (error) {',
      '  restoreCaches(internal, backup)',
      '  return { ok: false, error: `re-import failed (${error?.message ?? error})`, restored: true }',
      '}',
    ].join('\n'),
    updater: [
      'async apply({ version, activate }) {',
      '  // ... stage / verify / install / verifyInstalled 全都成功之后',
      '  if (activate !== undefined) {',
      '    await activate()',
      '  }',
      '  try {',
      '    await this.activate(installed)',
      '  } catch (error) {',
      '    this.restoreBackup()',
      '    throw error',
      '  }',
      '}',
    ].join('\n'),
  },
  fixed: {
    reload: [
      'const internal = loader.internal',
      'const backup = purgeCaches(internal, packageUrl)',
      'if (backup.esm.size === 0) {',
      "  logger.warn?.('our-free-model: host module cache is unavailable; hot reload requires a host restart')",
      "  return { ok: false, error: 'safe hot reload is unavailable in this host; restart the host to load installed files', restored: true, restartRequired: true }",
      '}',
      "logger.info?.(`our-free-model: hot reload purging ${backup.esm.size} cached module(s)`)",
      'try {',
      '  replacement = await importFresh(entryUrl)',
      '  if (options.expectedVersion !== undefined && replacement.version !== options.expectedVersion) {',
      '    throw new Error(`activation version mismatch: expected ${options.expectedVersion}`)',
      '  }',
      '} catch (error) {',
      '  return { ok: false, error: `re-import failed (${error?.message ?? error})`, restored: true }',
      '}',
    ].join('\n'),
    updater: [
      'const restartRequiredVersions = new Map()',
      'async apply({ version, activate }) {',
      '  if (activate !== undefined) {',
      '    const act = await activate()',
      '    if (act?.deferred) {',
      "      this.saveUpgradeState({ ...state, phase: 'complete', activated: false, restartRequired: true })",
      '      return { ok: true, version, deferred: true }',
      '    }',
      '  }',
      '}',
      'reconcileRecovery() {',
      "  if (state?.phase === 'complete' && state.restartRequired === true) return",
      '}',
    ].join('\n'),
  },
}

function selftest() {
  const buggy = auditSources(FIXTURE.buggy.reload, FIXTURE.buggy.updater)
  const fixed = auditSources(FIXTURE.fixed.reload, FIXTURE.fixed.updater)
  const cases = [
    ['缺陷版（报告里那段代码的形状）', buggy.verdict.code, 'DEFECT'],
    ['修复版（2.8.x 的空缓存守卫 + restartRequired）', fixed.verdict.code, 'FIXED'],
  ]
  let bad = 0
  console.log('自检：判定器对两份合成源码的结论（能分辨才算数）\n')
  for (const [name, got, want] of cases) {
    const ok = got === want
    if (!ok) bad++
    console.log(`  ${ok ? '✅' : '❌'} ${name} → ${got}（期望 ${want}）`)
  }
  console.log('')
  if (bad) {
    console.error(`自检失败 ${bad} 项：判定器不可信，别用它下结论。`)
    process.exit(1)
  }
  console.log('自检通过：同一个判定函数在缺陷形状上判 DEFECT、在修复形状上判 FIXED。')
}

/* ------------------------------------------------------------------ 现场 */
function findPluginDirs() {
  const explicit = flag('dir')
  if (explicit) return [explicit]
  const base = path.join(HOME, '.dsh', 'profiles')
  const out = []
  try {
    for (const p of fs.readdirSync(base)) {
      const d = path.join(base, p, 'node_modules', 'dsh-our-free-model')
      if (fs.existsSync(path.join(d, 'package.json'))) out.push(d)
    }
  } catch { /* 没有 profiles 就算了 */ }
  return out
}

function readIf(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return null }
}

function stateFile() {
  const d = flag('state')
  return d ? path.join(d, 'upgrade-state.json') : path.join(HOME, '.dsh', 'our-free-model', 'upgrade-state.json')
}

function logDirs() {
  return [
    path.join(HOME, '.dsh', 'logs'),
    path.join(process.env.APPDATA || '', 'DSH Desktop', 'logs'),
    path.join(process.env.APPDATA || '', 'DSH NEXT', 'logs'),
    path.join(process.env.APPDATA || '', 'dsh-desktop', 'logs'),
  ].filter((d) => d && fs.existsSync(d))
}

function scanLogs() {
  const found = { purging: [], mismatch: 0, rolledBack: 0, files: 0 }
  const walk = (dir, depth) => {
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory() && depth < 3) { walk(p, depth + 1); continue }
      if (!e.isFile() || !/\.log$/i.test(e.name)) continue
      const text = readIf(p)
      if (!text) continue
      found.files++
      for (const m of text.matchAll(/hot reload purging\s+(\d+)\s+cached module/gi)) found.purging.push(Number(m[1]))
      found.mismatch += (text.match(/activation version mismatch/gi) || []).length
      found.rolledBack += (text.match(/"phase"\s*:\s*"rolled-back"|previous files restored/gi) || []).length
    }
  }
  for (const d of logDirs()) walk(d, 0)
  return found
}

function main() {
  if (has('selftest')) return selftest()

  const dirs = findPluginDirs()
  const statePath = stateFile()
  const state = readIf(statePath)
  const parsedState = state ? (() => { try { return JSON.parse(state) } catch { return null } })() : null
  const logs = has('logs') ? scanLogs() : null

  const results = []
  for (const dir of dirs) {
    const pkg = (() => { try { return JSON.parse(readIf(path.join(dir, 'package.json')) || '{}') } catch { return {} } })()
    const reloadSrc = readIf(path.join(dir, 'src', 'reload.js')) || ''
    const updaterSrc = readIf(path.join(dir, 'src', 'updater.js')) || ''
    const audit = (reloadSrc && updaterSrc)
      ? auditSources(reloadSrc, updaterSrc)
      : { checks: [], verdict: { code: 'UNKNOWN', label: '找不到 src/reload.js + src/updater.js（目录给错了？）' }, judged: [], passed: 0 }
    results.push({ dir, version: pkg.version || '?', hasSrc: Boolean(reloadSrc && updaterSrc), ...audit })
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ pluginDirs: dirs, results, state: parsedState, statePath, logs }, null, 2))
    return
  }

  console.log('dsh-our-free-model · 应用内升级会不会回滚  只读审计')
  console.log('='.repeat(72))
  if (!results.length) {
    console.log('没找到已安装的 dsh-our-free-model。用 --dir <插件目录> 指定一份。\n')
  }
  for (const r of results) {
    console.log(`\n插件目录：${r.dir}`)
    console.log(`版本：${r.version}`)
    for (const c of r.checks) {
      const mark = c.ok === null ? '·' : c.ok ? '✅' : '❌'
      console.log(`  ${mark} [${c.id}] ${c.title}`)
      console.log(`      ${c.detail}`)
    }
    if (r.judged.length) {
      console.log(`  小计：${r.passed}/${r.judged.length} 项通过`)
    }
    console.log(`  结论：${r.verdict.code} —— ${r.verdict.label}`)
  }

  console.log('\n' + '-'.repeat(72))
  console.log(`upgrade-state.json：${statePath}`)
  if (!parsedState) {
    console.log(state ? '  读到了但解析失败（截断？）' : '  不存在（没做过升级、或数据目录不同 ⇒ 用 --state 指过去）')
  } else {
    const at = parsedState.at ? new Date(parsedState.at).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '?'
    console.log(`  ${parsedState.from ?? '?'} → ${parsedState.to ?? '?'} @ ${at}`)
    console.log(`  phase=${parsedState.phase}  activated=${parsedState.activated}` +
      (parsedState.diskRestored !== undefined ? `  diskRestored=${parsedState.diskRestored}` : '') +
      (parsedState.restartRequired !== undefined ? `  restartRequired=${parsedState.restartRequired}` : ''))
    if (parsedState.error) console.log(`  error=${parsedState.error}`)
    console.log('')
    if (parsedState.phase === 'rolled-back' && parsedState.diskRestored === true) {
      console.log('  ⚠️ 这是报告里那个形态：磁盘已经升级成功并被回滚（diskRestored: true）。')
    } else if (parsedState.phase === 'complete' && parsedState.activated === false) {
      console.log('  ⭐ 这是「装完、未热激活、等重启」的形态 —— 修复版应有的样子，不是失败。')
    }
  }

  if (logs) {
    console.log('\n' + '-'.repeat(72))
    console.log('宿主日志（--logs）')
    if (!logs.files) {
      console.log('  没找到可读的 *.log（本机日志目录不在候选表里）⇒ 跳过，不影响源码判定。')
    } else {
      console.log(`  扫了 ${logs.files} 个日志文件`)
      const zero = logs.purging.filter((n) => n === 0).length
      console.log(`  「hot reload purging N cached module(s)」出现 ${logs.purging.length} 次，其中 N=0 的 ${zero} 次` +
        (zero ? '  ← 印证宿主根本导不出模块缓存' : ''))
      if (logs.purging.length) {
        const uniq = [...new Set(logs.purging)].sort((a, b) => a - b).slice(0, 8)
        console.log(`  N 的取值：${uniq.join(', ')}`)
      }
      console.log(`  「activation version mismatch」出现 ${logs.mismatch} 次`)
      console.log(`  「rolled-back」/「previous files restored」出现 ${logs.rolledBack} 次`)
      const hits = logs.purging.length + logs.mismatch + logs.rolledBack
      if (!hits) {
        console.log('  本机这些日志里一行都没命中（多半已轮转/清理，或这台机器没经历过那些升级尝试）')
        console.log('  ⇒ 只是少了一份旁证，上面的源码判定与 upgrade-state.json 不受影响。')
      } else {
        console.log('  判读：N 恒为 0 + mismatch/rolled-back 有计数 ⇒ 每次升级都在「热激活」这一步被撤掉。')
      }
    }
  } else {
    console.log('\n（想连日志一起看：加 --logs）')
  }
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
