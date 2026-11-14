#!/usr/bin/env node
/**
 * chorography T1 审计器 · locateCliJs() 的 asar 路径（对应上游 slow-stack/mneme#578）
 *
 * 问题一句话：T1 的 headless runner 用一条硬编码路径拼出 `dsh-desktop-host/lib/cli.js`，
 * 拼接假设的是「DeepSeek Harness」这套安装布局。DSH NEXT 桌面版的 asar 里既没有顶层
 * `dsh/` 目录，也没有 `dsh-desktop-host` 这个包，真入口是 `app.asar/lib/desktop-cli.js`。
 * 于是 spawn 出去的进程拿着一份不存在的入口，只报「headless 退出码 1：(无输出)」。
 *
 * 这个脚本只读：不加载插件、不 spawn 宿主、不改任何文件。
 * 它回答一个问题 —— **你这份 mneme 里，那两条路径的假设还成不成立。**
 *
 *   node audit-t1-locate.cjs                      # 自动找 mneme + 自动找安装目录
 *   node audit-t1-locate.cjs --exe "D:/DSH NEXT/DSH NEXT.exe"
 *   node audit-t1-locate.cjs --asar "D:/DSH NEXT/resources/app.asar"
 *   node audit-t1-locate.cjs --plugin <dir> --json
 *   node audit-t1-locate.cjs --selftest
 *
 * 退出码：0 = 审计跑完（缺陷有无不影响退出码）｜1 = 自检未通过｜2 = 参数或环境错误
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const CLI_PATH_TAIL = ["dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js"];
const REAL_CLI_CANDIDATES = [
  ["lib", "desktop-cli.js"],
  ["lib", "main.js"],
];

/* ------------------------------- 参数 ------------------------------- */

function parseArgs(argv) {
  const out = { json: false, selftest: false, plugin: null, exe: null, asar: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--selftest") out.selftest = true;
    else if (a === "--plugin") out.plugin = argv[++i];
    else if (a === "--exe") out.exe = argv[++i];
    else if (a === "--asar") out.asar = argv[++i];
    else if (a === "-h" || a === "--help") out.help = true;
    else {
      console.error(`未知参数：${a}`);
      process.exit(2);
    }
  }
  return out;
}

/* --------------------------- 定位 mneme --------------------------- */

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function isDirLike(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith("."));
  } catch {
    return [];
  }
}

/** 在 node_modules 里找 @modusensus/dsh-mneme（含 pnpm 的软链布局）。 */
function findMnemeIn(nodeModules) {
  const scoped = path.join(nodeModules, "@modusensus");
  for (const e of listDirs(scoped)) {
    if (e.name !== "dsh-mneme") continue;
    const p = path.join(scoped, e.name);
    if (isDirLike(p)) return p;
  }
  return null;
}

function resolvePlugin(explicit) {
  if (explicit) {
    const p = path.resolve(explicit);
    if (!isDirLike(p)) throw new Error(`--plugin 不是目录：${p}`);
    return p;
  }
  const home = os.homedir();
  const profilesRoot = path.join(home, ".dsh", "profiles");
  const hits = [];
  for (const e of listDirs(profilesRoot)) {
    const prof = path.join(profilesRoot, e.name);
    if (!isDirLike(prof)) continue;
    // profile 自己也可能就是包装出来的（root 下直接有 node_modules）
    const nm = path.join(prof, "node_modules");
    if (isDirLike(nm)) {
      const hit = findMnemeIn(nm);
      if (hit) hits.push({ profile: e.name, dir: hit });
    }
    // 或者 profile 下还有子 profile
    for (const sub of listDirs(prof)) {
      const nm2 = path.join(prof, sub.name, "node_modules");
      if (!isDirLike(nm2)) continue;
      const hit = findMnemeIn(nm2);
      if (hit) hits.push({ profile: `${e.name}/${sub.name}`, dir: hit });
    }
  }
  if (hits.length === 0) throw new Error("在 ~/.dsh/profiles 下没找到 @modusensus/dsh-mneme（可用 --plugin 指定）");
  return hits[0].dir;
}

/* --------------------------- 源码判定 --------------------------- */

/** 从源码里抠出一个顶层函数的函数体（按花括号配平），找不到返回 null。 */
function extractFunctionBody(src, name) {
  const re = new RegExp(`(?:export\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`);
  const m = re.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length - 1; // 指向 '{'
  let depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/** 同上，但按候选名单逐个试 —— 上游把 locateCliJs 改名成 resolveCliJs 是已经发生过的演进，
 *  只认一个函数名会把「已经修好」的新版本判成 SUSPECT。 */
function extractAnyFunctionBody(src, names) {
  for (const n of names) {
    const b = extractFunctionBody(src, n);
    if (b) return { body: b, name: n };
  }
  return { body: null, name: null };
}

/**
 * 判 locateCliJs 的形状。
 * hardcoded：函数里直接拼 "dsh"/"node_modules"/"dsh-desktop-host" 这一串，且没有候选与探测。
 * candidates：出现候选路径集合 / 循环试路径 / existsSync 探测 / 提到真入口 desktop-cli。
 */
function judgeLocateCli(body) {
  if (!body) return { shape: "unknown", hardcoded: false, candidates: false, asarAware: false, returnsNull: false };

  const hardcoded =
    /(["'])dsh\1\s*,\s*(["'])node_modules\2/.test(body) &&
    /dsh-desktop-host/.test(body) &&
    !/for\s*\(|\.some\(|\.find\(|CANDIDATES|候选/.test(body);

  const candidates =
    /desktop-cli/.test(body) ||
    /CANDIDATES|候选/.test(body) ||
    /for\s*\(\s*const\s+\w+\s+of\s*\[/.test(body) ||
    (/existsSync\s*\(/.test(body) && !/不能\s*existsSync/.test(body) && body.split("existsSync").length > 2);

  const asarAware = /original-fs|@electron\/asar|extractFile|readAsar|asar\.listPackage/.test(body);
  const returnsNull = /return\s+(null|undefined)\s*;/.test(body);

  let shape;
  if (candidates) shape = "probe"; // 有候选或探测
  else if (hardcoded) shape = "hardcoded";
  else if (!/app\.asar/.test(body)) shape = "unknown";
  else shape = "hardcoded";

  return { shape, hardcoded, candidates, asarAware, returnsNull };
}

/** lokateDshExe 是否只认「DeepSeek Harness」这一个名字/位置。 */
function judgeLocateExe(body) {
  if (!body) return { shape: "unknown", dsNextCovered: false, mentionsEnv: false };
  // 新版把名字挪进了模块级常量表（DSH_EXE_NAMES = [... "dsh next.exe" ...]），函数体里只留
  // 一句 includes 与 roots 循环 —— 所以除 "dsh next.exe" 字面，也认 "DSH NEXT" 这个目录名
  // 与 DSH_EXE 环境变量覆盖。只按 "deepseek harness.exe" 判会把新版误判成 single-name。
  const mentionsNext = /dsh[\s_-]?next/i.test(body);
  const mentionsEnv = /DSH_EXE\b/.test(body);
  const onlyHarness = /deepseek harness\.exe/i.test(body) && !mentionsNext;
  return { shape: onlyHarness ? "single-name" : "multi-name", dsNextCovered: !onlyHarness, mentionsEnv };
}

/* ----------------------------- asar 读取 ----------------------------- */
/* 零依赖读 asar 目录索引：头部是 Chromium pickle，
   [0..3]=4 [4..7]=头部 pickle 总长 [8..11]=JSON 长度+4 [12..15]=JSON 长度，随后是 JSON。 */

function readAsarIndex(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  try {
    const b = Buffer.alloc(16);
    fs.readSync(fd, b, 0, 16, 0);
    const jsonLen = b.readUInt32LE(12);
    if (!Number.isFinite(jsonLen) || jsonLen <= 0 || jsonLen > 64 * 1024 * 1024) {
      throw new Error(`asar 头部长度异常：${jsonLen}`);
    }
    const hb = Buffer.alloc(jsonLen);
    fs.readSync(fd, hb, 0, jsonLen, 16);
    return JSON.parse(hb.toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

/** 在 asar 索引里按路径段找节点；'index.files' 是目录结构。 */
function asarHas(index, segments) {
  let node = index;
  for (const seg of segments) {
    const files = node && node.files;
    if (!files || !files[seg]) return false;
    node = files[seg];
  }
  return true;
}

function asarList(index, segments) {
  let node = index;
  for (const seg of segments) {
    const files = node && node.files;
    if (!files || !files[seg]) return [];
    node = files[seg];
  }
  return Object.keys(node.files || {});
}

/* --------------------------- 定位安装目录 --------------------------- */

function candidateExes() {
  const out = [];
  if (process.env.DSH_EXE) out.push(process.env.DSH_EXE);
  if (process.env.DSH_NEXT_EXE) out.push(process.env.DSH_NEXT_EXE);
  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  for (const base of [pf, pf86, "D:\\", "C:\\", path.join(os.homedir(), "AppData", "Local", "Programs")]) {
    out.push(path.join(base, "DSH NEXT", "DSH NEXT.exe"));
    out.push(path.join(base, "DeepSeek Harness", "DeepSeek Harness.exe"));
  }
  return out;
}

function resolveAsar(args) {
  if (args.asar) {
    const p = path.resolve(args.asar);
    if (!fs.existsSync(p)) throw new Error(`--asar 不存在：${p}`);
    return { asar: p, exe: null, how: "--asar" };
  }
  if (args.exe) {
    const exe = path.resolve(args.exe);
    const asar = path.join(path.dirname(exe), "resources", "app.asar");
    if (!fs.existsSync(asar)) throw new Error(`--exe 旁边没有 resources/app.asar：${asar}`);
    return { asar, exe, how: "--exe" };
  }
  for (const exe of candidateExes()) {
    if (!exe || !fs.existsSync(exe)) continue;
    const asar = path.join(path.dirname(exe), "resources", "app.asar");
    if (fs.existsSync(asar)) return { asar, exe, how: "常见安装位" };
  }
  return { asar: null, exe: null, how: null };
}

/* ----------------------------- 自检 ----------------------------- */

function selftest() {
  const cases = [];
  const ok = (name, cond, detail) => cases.push({ name, pass: !!cond, detail });

  const defectBody = `function locateCliJs(exe) {
  return join(dirname(exe), "resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js");
}`;
  const fixedBody = `function locateCliJs(exe) {
  const CANDIDATES = [["lib", "desktop-cli.js"], ["dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js"]];
  for (const parts of CANDIDATES) {
    const p = join(dirname(exe), "resources", "app.asar", ...parts);
    if (existsSync(p)) return p;
  }
  return null;
}`;
  const exeSingle = `function locateDshExe() {
  const standard = join(process.env["ProgramFiles"] ?? "C:\\\\Program Files", "DeepSeek Harness", "DeepSeek Harness.exe");
  return existsSync(standard) ? standard : null;
}`;

  const a = judgeLocateCli(defectBody);
  ok("缺陷形判 hardcoded", a.shape === "hardcoded", a.shape);
  const b = judgeLocateCli(fixedBody);
  ok("修好形判 probe", b.shape === "probe", b.shape);
  ok("修好形不再算硬编码", b.hardcoded === false, String(b.hardcoded));
  const c = judgeLocateExe(exeSingle);
  ok("只认 DeepSeek Harness 判 single-name", c.shape === "single-name", c.shape);

  // 2026-11 新增：上游把函数改名 resolveCliJs、并把 DSH NEXT 写进 roots 的两种新形状。
  const fixedNewBody = `export function resolveCliJs(exe, env = process.env) {
  const asar = join(dirname(exe), "resources", "app.asar");
  const explicit = typeof env.DSH_CLI_JS === "string" && env.DSH_CLI_JS !== "" ? env.DSH_CLI_JS : null;
  const candidates = [explicit, join(asar, "lib", "desktop-cli.js")].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { path: candidate, candidates, verified: true };
  }
  return { path: null, candidates, verified: false };
}`;
  const b2 = judgeLocateCli(fixedNewBody);
  ok("改名后的 resolveCliJs 形状判 probe", b2.shape === "probe", b2.shape);
  ok("extractAnyFunctionBody 按别名找到 resolveCliJs",
     extractAnyFunctionBody("const x = 1;\n" + fixedNewBody + "\n", ["locateCliJs", "resolveCliJs"]).name === "resolveCliJs", "");

  const exeMulti = `function locateDshExe(env = process.env) {
  const roots = [env["ProgramFiles"] ?? "C:/Program Files"];
  for (const root of roots) {
    for (const name of ["DeepSeek Harness", "DSH NEXT"]) {
      const candidate = join(root, name, name + ".exe");
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}`;
  const c2 = judgeLocateExe(exeMulti);
  ok("roots 里含 DSH NEXT 判认得", c2.dsNextCovered === true, c2.shape);

  // asar 索引遍历：合成结构
  const idx = { files: { lib: { files: { "desktop-cli.js": { size: 1 } } }, dsh: { files: {} } } };
  ok("asarHas 命中 lib/desktop-cli.js", asarHas(idx, ["lib", "desktop-cli.js"]), "");
  ok("asarHas 未命中 dsh/.../cli.js", !asarHas(idx, CLI_PATH_TAIL), "");
  ok("asarList 列出 lib", asarList(idx, ["lib"]).join(",") === "desktop-cli.js", "");

  // 真 asar 若在本机，顺手验一次解析器（不算失败项，只做旁证）
  let real = null;
  try {
    const r = resolveAsar({});
    if (r.asar) {
      const index = readAsarIndex(r.asar);
      real = { asar: r.asar, top: asarList(index, []).length, parsed: true };
    }
  } catch {
    real = { parsed: false };
  }

  const failed = cases.filter((x) => !x.pass);
  for (const x of cases) console.log(`  ${x.pass ? "ok  " : "FAIL"}  ${x.name}${x.detail ? `  (${x.detail})` : ""}`);
  if (real) console.log(`  info  真 asar 解析：${real.parsed ? `成功，顶层 ${real.top} 项` : "未解析（本机没有安装目录，可 --asar 指定）"}`);
  console.log(`\n自检 ${cases.length - failed.length}/${cases.length} 通过`);
  return failed.length === 0;
}

/* ----------------------------- 主流程 ----------------------------- */

function pad(s, n) {
  s = String(s);
  if (s.length <= n) return s + " ".repeat(n - s.length);
  return s.slice(0, Math.max(0, n - 3)) + "...";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]);
    return 0;
  }
  if (args.selftest) return selftest() ? 0 : 1;

  const plugin = resolvePlugin(args.plugin);
  const pkg = readJsonSafe(path.join(plugin, "package.json")) || {};
  const t1Path = path.join(plugin, "lib", "wiki", "t1.js");
  const src = fs.readFileSync(t1Path, "utf8");

  const locateFn = extractAnyFunctionBody(src, ["locateCliJs", "resolveCliJs", "resolveCliPath", "locateCli"]);
  const locateBody = locateFn.body;
  const exeBody = extractFunctionBody(src, "locateDshExe");
  const cli = judgeLocateCli(locateBody);
  const exe = judgeLocateExe(exeBody);

  // 实测侧：真安装里那两条路径到底存不存在
  let installed = null;
  try {
    const r = resolveAsar(args);
    if (r.asar) {
      const index = readAsarIndex(r.asar);
      const deepseekScope = path.join("@deepseek-ai");
      const pkgs = asarList(index, ["node_modules", deepseekScope]);
      installed = {
        how: r.how,
        asar: r.asar,
        exe: r.exe,
        top: asarList(index, []),
        hardcodedPathExists: asarHas(index, CLI_PATH_TAIL),
        desktopCli: REAL_CLI_CANDIDATES.filter((c) => asarHas(index, c)).map((c) => c.join("/")),
        hostPkgPresent: pkgs.includes("dsh-desktop-host"),
        scopeCount: pkgs.length,
      };
    }
  } catch (e) {
    installed = { error: String(e && e.message ? e.message : e) };
  }

  // 结论
  let verdict = "SUSPECT";
  const reasons = [];
  if (cli.shape === "unknown") {
    verdict = "SUSPECT";
    reasons.push("没能从源码里判定 CLI 定位函数的形状（试过 locateCliJs / resolveCliJs / resolveCliPath，可能被改名或压缩）");
  } else if (cli.shape === "probe") {
    verdict = "FIXED";
    reasons.push("locateCliJs 已经是候选/探测形状，不再写死单条 asar 路径");
  } else if (installed && installed.hardcodedPathExists) {
    verdict = "SUSPECT";
    reasons.push("源码仍是硬编码，但本机这条路径真的存在 —— 这台安装上它恰好能用");
  } else if (installed && installed.error) {
    verdict = "SUSPECT";
    reasons.push("源码是硬编码，但本机没找到安装目录，无法验证路径是否存在（用 --exe/--asar 指定）");
  } else if (installed && !installed.hardcodedPathExists) {
    verdict = "DEFECT";
    reasons.push("源码硬编码的 asar 路径在你这台安装里不存在");
    if (!installed.hostPkgPresent) reasons.push("而且整个安装里没有 dsh-desktop-host 这个包");
    if (installed.desktopCli.length) reasons.push(`真入口在 ${installed.desktopCli.join(" / ")}`);
  } else {
    verdict = "SUSPECT";
    reasons.push("源码是硬编码，本机安装信息不足");
  }

  /* ---- 输出 ---- */
  console.log(`chorography T1 审计 · locateCliJs 与 asar 布局（对应上游 #578）\n`);
  console.log(`插件    ${plugin}`);
  console.log(`版本    ${pkg.version || "?"}  ${pkg.name || ""}\n`);

  console.log("源码侧（lib/wiki/t1.js）");
  console.log(`  ${cli.shape === "probe" ? "ok   " : "MISS "} A  CLI 定位有候选路径 / 探测回退（${locateFn.name || "未找到定位函数"}）  ${cli.shape === "probe" ? "有" : "无（单条硬编码拼接）"}`);
  console.log(`  ${cli.asarAware ? "ok   " : "--   "} B  能读 asar 内部（original-fs / @electron/asar）  ${cli.asarAware ? "有" : "没有"}`);
  console.log(`  ${cli.returnsNull ? "ok   " : "--   "} C  定位失败会返回 null（触发 environment 降级）    ${cli.returnsNull ? "会" : "不会（直接把路径给出去）"}`);
  console.log(`  ${exe.dsNextCovered ? "ok   " : "MISS "} D  locateDshExe 认得 DSH NEXT 的 exe 名/位置        ${exe.dsNextCovered ? `认得${exe.mentionsEnv ? "，另有 DSH_EXE 覆盖" : ""}` : "只认 deepseek harness.exe + Program Files\\DeepSeek Harness"}`);
  console.log("");

  if (installed && !installed.error) {
    console.log(`实测侧（${installed.how}）`);
    console.log(`  安装     ${installed.asar}`);
    if (installed.exe) console.log(`  主程序   ${installed.exe}`);
    console.log(`  asar 顶层 ${installed.top.join(" ")}`);
    console.log(`  硬编码路径 dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js → ${installed.hardcodedPathExists ? "存在" : "**不存在**"}`);
    console.log(`  真入口候选 ${installed.desktopCli.length ? installed.desktopCli.join(" · ") : "未找到"}`);
    console.log(`  @deepseek-ai 包数 ${installed.scopeCount}，其中 dsh-desktop-host ${installed.hostPkgPresent ? "存在" : "**不存在**"}`);
    console.log("");
  } else if (installed && installed.error) {
    console.log(`实测侧   跳过：${installed.error}\n`);
  }

  console.log(`结论 ${verdict}`);
  for (const r of reasons) console.log(`  · ${r}`);
  console.log("");
  console.log("提醒：这条缺陷不会报错，只表现为「headless 退出码 1：(无输出)」—— 拿不到栈，因为它没跑到能打栈的地方。");
  console.log("      判定器本身用 --selftest 验，先信自检再信结论。");
  return 0;
}

if (require.main === module) {
  let code = 0;
  try {
    code = main();
  } catch (e) {
    console.error(`错误：${e && e.message ? e.message : e}`);
    code = 2;
  }
  process.exit(code);
}

module.exports = { judgeLocateCli, judgeLocateExe, extractFunctionBody, asarHas, asarList, readAsarIndex };
