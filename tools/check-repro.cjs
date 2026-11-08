#!/usr/bin/env node
/**
 * dsh-repro 的自检：把「一条命令能判定」这件事本身也纳入 CI。
 *
 * 三个判定组：
 *   S  selftest  —— 每个审计器的 --selftest 必须通过（喂合成源码/内存库，离线可跑，不读本机安装）
 *   I  index     —— README.md 与 README.en.md 的索引行数必须相等（21 条）
 *   L  link      —— 仓库内相对链接指向的文件必须存在
 *
 * 只读：不修改任何文件，不联网，不安装依赖。失败只标红。
 * 退出码：0 = 全过；1 = 有判定项不通过；2 = 环境/参数错误。
 *
 * 用法：node tools/check-repro.mjs [--verbose]
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const VERBOSE = process.argv.includes('--verbose')
const lines = []
let failed = 0
const problems = []

function log(s) { lines.push(s); console.log(s) }
function fail(group, msg) { failed++; problems.push(`${group}: ${msg}`) }

// ── 0. 发现审计器 ────────────────────────────────────────────────────────────
function walk(dir, out = [], extRe = /\.(cjs|mjs)$/) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out, extRe)
    else if (extRe.test(e.name)) out.push(p)
  }
  return out
}

const reproDir = path.join(ROOT, 'repro')
if (!fs.existsSync(reproDir)) {
  console.error(`没有 repro/ 目录：${reproDir}`)
  process.exit(2)
}

const all = walk(reproDir).map(p => ({ abs: p, rel: path.relative(ROOT, p).split(path.sep).join('/') }))
const src = new Map(all.map(f => [f.rel, fs.readFileSync(f.abs, 'utf8')]))
const withSelftest = all.filter(f => /--selftest|'selftest'|"selftest"/.test(src.get(f.rel)))
const withoutSelftest = all.filter(f => !withSelftest.includes(f))

// ── S. selftest ──────────────────────────────────────────────────────────────
log(`S  审计器自检（--selftest）：${withSelftest.length} 个`)
for (const f of withSelftest) {
  const r = spawnSync(process.execPath, [f.abs, '--selftest'], {
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, NO_COLOR: '1' },
  })
  const ok = r.status === 0
  const tail = (r.stdout || r.stderr || '').trim().split('\n').filter(Boolean).slice(-1)[0] || '(无输出)'
  if (ok) {
    log(`   ✅ ${f.rel}`)
    if (VERBOSE) log(`        ${tail}`)
  } else {
    log(`   ❌ ${f.rel}  exit=${r.status}`)
    const detail = (r.stdout || '') + (r.stderr || '')
    for (const l of detail.trim().split('\n').slice(-12)) log(`        ${l}`)
    fail('selftest', `${f.rel} 自检未通过（exit=${r.status}）`)
  }
}
if (withoutSelftest.length) {
  log(`   · 跳过 ${withoutSelftest.length} 个（非判定器，需要真实环境或密钥）：`)
  for (const f of withoutSelftest) log(`        ${f.rel}`)
}

// ── I. 索引行数 ──────────────────────────────────────────────────────────────
const readmeZh = path.join(ROOT, 'README.md')
const readmeEn = path.join(ROOT, 'README.en.md')
const countRows = (p) => {
  if (!fs.existsSync(p)) return null
  const txt = fs.readFileSync(p, 'utf8')
  return (txt.match(/^\|\s*0\d{3}\s*\|/gm) || []).length
}
const zh = countRows(readmeZh)
const en = countRows(readmeEn)
log(`I  索引行数：README.md=${zh ?? '缺失'} / README.en.md=${en ?? '缺失'}`)
if (zh === null || en === null) fail('index', '两版 README 至少缺一个')
else if (zh !== en) fail('index', `中英索引行数不一致（zh=${zh} en=${en}）`)
else if (zh < 1) fail('index', '索引里没有任何 0xxx 行')
else log(`   ✅ 一致（${zh} 条）`)

// ── L. 相对链接 ──────────────────────────────────────────────────────────────
const mdFiles = [
  ...(fs.existsSync(readmeZh) ? [readmeZh] : []),
  ...(fs.existsSync(readmeEn) ? [readmeEn] : []),
]
for (const d of ['reports', 'repro']) {
  const abs = path.join(ROOT, d)
  if (!fs.existsSync(abs)) continue
  for (const f of walk(abs, [], /\.md$/)) mdFiles.push(f)
}
let linkCount = 0
const broken = []
for (const f of mdFiles) {
  const base = path.dirname(f)
  const txt = fs.readFileSync(f, 'utf8')
  const rels = path.relative(ROOT, f).split(path.sep).join('/')
  for (const m of txt.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1]
    if (/^(https?:|mailto:|#)/.test(target)) continue
    const clean = decodeURI(target.split('#')[0])
    if (!clean) continue
    linkCount++
    if (!fs.existsSync(path.resolve(base, clean))) broken.push(`${rels} → ${target}`)
  }
}
log(`L  相对链接：${mdFiles.length} 个文件、${linkCount} 条链接`)
if (broken.length) {
  for (const b of broken) log(`   ❌ ${b}`)
  fail('link', `${broken.length} 条相对链接指向不存在的文件`)
} else {
  log('   ✅ 无断链')
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────
console.log('')
if (failed === 0) {
  console.log(`✅ 全部通过：${withSelftest.length} 个审计器自检 + 索引 ${zh} 条 + ${linkCount} 条相对链接`)
  process.exit(0)
}
console.log(`❌ ${failed} 项不通过：`)
for (const p of problems) console.log(`   · ${p}`)
process.exit(1)
