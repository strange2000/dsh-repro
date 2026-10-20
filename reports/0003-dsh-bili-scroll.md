# dsh-bili-scroll 在「DSH NEXT 桌面版 2.0.19-next（内含 @deepseek-ai/dsh 0.2.1-rc.2，Windows）」上装完直接用不了的三处 bug

> 环境：Windows 11 25H2 · DSH NEXT 桌面版 `2.0.19-next` · 内置 `@deepseek-ai/dsh` **0.2.1-rc.2**（Electron + asar）· 插件 `dsh-bili-scroll` **0.1.7**（插件市场安装，profile `desktop`）
> 状态：三处都已在本地 `node_modules` 里改通并实测跑完整轮（挑 5 条、写出 `out/<日期>.md`、追加 `seen.md`）
> 下面每条都给了「症状 / 根因（带行号）/ 最小改法 / 如何验证」，可以直接照着改

---

## Bug 1（严重，装完第一步就卡死）：`pythonPath` 被解析回 `'python'`，扫码永远不出图

### 症状

- 设置页点「扫码登录」，**什么都不发生**（没有二维码图片）。
- `duty.log` 只留一句：

  ```
  出码：https://account.bilibili.com/h5/account-h5/auth/scan-web?...（没画出 PNG —— venv 里大概还没有 qrcode）
  ```

  ⚠️ **这句提示是误导**：venv 里 `qrcode` / `pillow` 都装好了，`install.log` 里 `Checked 4 packages`、`exit 0`、`venvReady=true`。
- 手工在设置里把 `pythonPath` 改成 `.venv\Scripts\python.exe`，**当场能出图**；重启 DSH 后**又不出图**。

### 根因

`index.js:225-234` 的 `loadCfg()`：

```js
const saved = savedCfg(); const row = settingsDesc()
if (!row) return clampPatch(saved)
const user = row.user || {}
const out = { ...hostCfg() }                                   // ①
for (const k of Object.keys(DEFAULTS)) if (user[k] === undefined) out[k] = saved[k]   // ②
return clampPatch(out)
```

- ① `hostCfg = () => normalize(config, { ...DEFAULTS })`，而 `config` 是 `apply(ctx, config)` 拿到的**启动瞬间快照**（`index.js:198`）。
- 宿主下发的 `config.pythonPath` 在这台机器上是**非标量**（对象），`normalize()` 只接受 `typeof base[k] === 'string'` 的标量 ⇒ 该键被丢掉 ⇒ 回落 `DEFAULTS.pythonPath === 'python'`。
- ② 于是 `config.json` 里那份正确的 venv 路径只在 `user.pythonPath === undefined` 时才生效 —— 而设置行里这个键**是有值的** ⇒ 永远用不上。
- 结果：每次出码都去 spawn 字符串 `"python"`。Windows 上 `python` 是微软商店的存根，`exit=9009`，而 `lib/login.mjs` 的 `renderQrPng()` 把 exit≠0 / error **全部吞掉**（`resolve(null)`），UI 上只表现为"点了没反应"。

加上诊断日志后能直接看到：

```
spawn → python="python"  png=...\qrcode_login.png  cwd=...\bili-duty
exit=9009
```

### 最小改法

`loadCfg()` 在 `return clampPatch(out)` 之前补一段兜底：

```js
if (!out.pythonPath || out.pythonPath === 'python') {
  const venvGuess = process.platform === 'win32'
    ? join(stateDir, '.venv', 'Scripts', 'python.exe')
    : join(stateDir, '.venv', 'bin', 'python')
  if (existsSync(venvGuess)) out.pythonPath = venvGuess
  else if (typeof saved.pythonPath === 'string' && saved.pythonPath) out.pythonPath = saved.pythonPath
}
```

顺带建议：`renderQrPng()` 的失败分支别静默，把 `exit code` / `err.stack` 写进 `login-debug.log`；那句「venv 里大概还没有 qrcode」改成「看 login-debug.log 里的 exit/error」。

### 验证

```
spawn → python="%DSH_HOME%\bili-duty\.venv\Scripts\python.exe"
exit=0，png 已生成
出码：…（已画成 PNG）
登录成功，凭证已写入 …\bili_credential.json
```

---

## Bug 2（严重，用户以为"设置坏了"）：保存设置时把**整份内存配置**写回磁盘，改一个冲掉一片

### 症状

- 设置页里改一个开关，等一下自己弹回去；更怪的是**改开关 A，开关 B 跟着变了**（像互斥）。
- 用户被迫反复拨同一个开关，`duty.log` 里连刷三次：

  ```
  设置已更新：{"peakValley":true}
  设置已更新：{"peakValley":true}
  设置已更新：{"peakValley":true}
  ```

- 现场三份值互相矛盾：

  | 位置 | `peakValley` | `replyToComments` |
  | --- | --- | --- |
  | 插件 `config.json` | **false** | true |
  | 宿主 `cordis.patch.yml` | **true** | true |
  | 插件内存 `cfg`（工具读回来的） | true | **false** |

### 根因

`index.js:238`：

```js
const saveCfg = (patch) => { Object.assign(cfg, normalize(patch, cfg)); writeJson(cfgFile, cfg) }
```

`writeJson(cfgFile, cfg)` 写的是**完整 `cfg`**。而 `cfg` 里带着 Bug 1 那套逻辑解析出来的陈旧值 ⇒ 改 A 键时，内存里陈旧的 B/C 键被一起写回磁盘。
配合 Bug 1 的读路径（启动快照优先），下一次读又是旧值 —— 于是"改一下、等一下、又变回去"。

### 最小改法

读写两端一起改：

```js
// 读：config.json 打底，再用设置行里新鲜的 user 层覆盖
const out = { ...saved }
Object.assign(out, pickValid(row?.user))

// 写：只落"已有的 + 本次 patch"，别把整份内存 cfg 摊出去
const saveCfg = (patch) => {
  Object.assign(cfg, normalize(patch, cfg))
  writeJson(cfgFile, { ...DEFAULTS, ...readJson(cfgFile, {}), ...pickValid(patch) })
}
```

其中 `pickValid(src)` 按 `DEFAULTS` 的类型只挑合法标量 / 字符串数组。

> 备注：0.1.9 / 0.1.10 的「本地优先」只改了**读**；`saveCfg` 写整份 `cfg` 这条**还在**，所以"改一个冲掉一片"在 0.1.10 上依然可能发生。

---

## Bug 3（挡在最后一步）：桌面版找不到 `dsh` + headless 缺凭证，跑一轮必失败

### 症状

点「跑一轮」，`duty.log` 依次出现：

```
⚠️ 找不到 dsh：桌面版多半不是 npm 全局安装的 ⇒ 请在设置里把「dsh 路径」指到 <应用目录>/…/@deepseek-ai/dsh/lib/bin.js
'dsh' 不是内部或外部命令
刷B站结束（window:night，code=1）
```

手工把「dsh 路径」指到 `D:\DSH NEXT\resources\app.asar\node_modules\@deepseek-ai\dsh\lib\bin.js` 之后，CLI 能起来了（`Processing request of type ListToolsRequest`），但下一句：

```
dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official";
store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it),
or export DEEPSEEK_API_KEY in the launching environment
刷B站结束（manual，code=1）
```

### 根因（两段）

1. **找 dsh**：`resolveDsh()`（`index.js:610-640`）按 `process.resourcesPath` 猜了三处：

   ```js
   ['app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
   ['app',              'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
   ['node_modules',     '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
   ```

   桌面版里 CLI **只在 `app.asar` 内**（`app.asar.unpacked` 下没有 `@deepseek-ai/dsh`）⇒ 三处全落空 ⇒ 退到 `dsh`，PATH 里没有。
   建议补一条：`['app.asar', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js']`。
   （`process.execPath` + `ELECTRON_RUN_AS_NODE=1` 这条 spawn 路子是对的，实测 `--version` → `0.2.1-rc.2`、`exit=0`。）

2. **headless 缺凭证**：DSH `0.2.1-rc.2` 的 `@deepseek-ai/dsh-headless` patch 把 `credentials` / `authorization` / `deepseek-account` 三行 `disabled: true` 了 ⇒ 那一轮读不到凭证库里的 key（`.credentials.yaml` 里 `DEEPSEEK_API_KEY` 明明在）。
   **这条 0.1.8 已经修了**（overlay 里重新打开这三项），但我这次是通过**插件市场**装的，拿到的是 **0.1.7** —— npm registry 上 `latest` 至今还是 `0.1.7`，而 GitHub main 已经 `0.1.10`。所以「从市场/ npm 装的人」会稳定命中这个已经修好的 bug。

### 建议

- `resolveDsh()` 增加 `app.asar` 那一条；
- **发布一个 ≥ 0.1.8 的 npm 版本**（现在 `npm i dsh-bili-scroll` / 市场装的都是 0.1.7，等于 0.1.8~0.1.10 的所有修复对这批用户都不存在）；
- overlay 里重开三行（0.1.8 已做，此处仅作复述）：

  ```yaml
  - id: credentials
    disabled: false
  - id: authorization
    disabled: false
  - id: deepseek-account
    disabled: false
  ```

### 验证

```
刷B站开跑（manual）：D:\DSH NEXT\DSH NEXT.exe …\app.asar\node_modules\@deepseek-ai\dsh\lib\bin.js --profile headless …
Processing request of type ListToolsRequest
…（真跑了 MCP 工具、读字幕、写报告）
刷B站结束（manual，code=0）
今天挑到 5 条（上限 5 条）
```

---

## 附：两个小问题（不挡流程）

1. **占位报告会留在最终报告里**：`stubReportIfMissing(code)` 在失败轮写了一份「这一轮没写出报告」的占位；之后同一补跑成功、按"追加"写进同一份 `out/<日期>.md` ⇒ 报告开头永远挂着那段失败说明。建议成功轮把占位段标记为已作废，或占位写进 `out/<日期>.failed.md`。
2. **`出码` 日志里那句「venv 里大概还没有 qrcode」**会把用户引到"重装依赖"的死路上（本次实测：venv 好好的）。建议改成带 exit code 的中性文案。
