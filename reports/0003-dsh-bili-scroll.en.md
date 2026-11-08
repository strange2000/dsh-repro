# dsh-bili-scroll: three bugs that make it unusable right after install on DSH NEXT desktop 2.0.19-next

> Environment: Windows 11 25H2 · DSH NEXT desktop `2.0.19-next` · bundled `@deepseek-ai/dsh` **0.2.1-rc.2** (Electron + asar) · plugin `dsh-bili-scroll` **0.1.7** (installed from the plugin marketplace, profile `desktop`)
> Status: all three were patched locally and a full duty round was run end to end (picked 5 videos, wrote `out/<date>.md`, appended to `seen.md`)
> Each bug below is written as: symptom / root cause (with line numbers) / minimal fix / how to verify — you can follow it directly

> [中文](0003-dsh-bili-scroll.md) · English
> Note: local absolute paths are abstracted to `<stateDir>` / `<app>` in this translation.

<!-- tl;dr-en -->
> **TL;DR**
> - Three bugs make `dsh-bili-scroll` 0.1.7 unusable right after install on DSH NEXT desktop 2.0.19-next (Windows): scan-to-login does nothing, settings toggles flip back, and headless duty runs cannot find credentials.
> - Bug 1: `loadCfg()` bases on the host's startup snapshot, which drops the non-scalar `pythonPath`, so it falls back to the bare `python` — the Microsoft Store stub on Windows (exit 9009) — and `renderQrPng()` swallows that non-zero exit, so no QR code ever renders.
> - Bug 2: `saveCfg()` writes the whole in-memory `cfg` back to disk, so changing key A erases B and C; the panel, `cordis.patch.yml` and `config.json` ended up holding three different values.
> - Bug 3: `resolveDsh()` hardcodes three `app.asar.unpacked` paths while the desktop CLI lives only inside `app.asar`, and the headless overlay disables the three services that carry credentials.
> - Every bug below is written as symptom / root cause (with line numbers) / minimal fix / how to verify, and all three were patched locally and a full duty round was run end to end.

---

## Bug 1 (severe, blocks the very first step): `pythonPath` resolves back to `'python'`, scan-to-login never renders an image

### Symptom

- Clicking "扫码登录" (scan to log in) in the settings page does **nothing at all** (no QR code image).
- `duty.log` only leaves one line:

  ```
  Dumping QR: https://account.bilibili.com/h5/account-h5/auth/scan-web?... (no PNG drawn — the venv probably does not have qrcode yet)
  ```

  ⚠️ **That hint is misleading**: `qrcode` and `pillow` are installed in the venv; `install.log` shows `Checked 4 packages`, `exit 0`, `venvReady=true`.
- Setting `pythonPath` to `.venv\Scripts\python.exe` by hand in the settings **works immediately**; after restarting DSH **it stops working again**.

### Root cause

`loadCfg()` at `index.js:225-234`:

```js
const saved = savedCfg(); const row = settingsDesc()
if (!row) return clampPatch(saved)
const user = row.user || {}
const out = { ...hostCfg() }                                   // ①
for (const k of Object.keys(DEFAULTS)) if (user[k] === undefined) out[k] = saved[k]   // ②
return clampPatch(out)
```

- ① `hostCfg = () => normalize(config, { ...DEFAULTS })`, and `config` is the **snapshot taken at startup**, handed to `apply(ctx, config)` (`index.js:198`).
- On this machine the `config.pythonPath` pushed down by the host is **not a scalar** (it is an object). `normalize()` only accepts scalars — `typeof base[k] === 'string'` — so that key is dropped and the value falls back to `DEFAULTS.pythonPath === 'python'`.
- ② Consequently the correct venv path in `config.json` only takes effect when `user.pythonPath === undefined` — but in the settings row this key **does have a value**, so the file value is never used.
- Result: every QR render spawns the literal string `"python"`. On Windows `python` is the Microsoft Store stub, `exit=9009`, and `renderQrPng()` in `lib/login.mjs` **swallows** every non-zero exit / error (`resolve(null)`), so all the UI shows is "clicked, nothing happened".

With diagnostics added, it is visible directly:

```
spawn → python="python"  png=<stateDir>\qrcode_login.png  cwd=<stateDir>
exit=9009
```

### Minimal fix

Add a fallback in `loadCfg()` right before `return clampPatch(out)`:

```js
if (!out.pythonPath || out.pythonPath === 'python') {
  const venvGuess = process.platform === 'win32'
    ? join(stateDir, '.venv', 'Scripts', 'python.exe')
    : join(stateDir, '.venv', 'bin', 'python')
  if (existsSync(venvGuess)) out.pythonPath = venvGuess
  else if (typeof saved.pythonPath === 'string' && saved.pythonPath) out.pythonPath = saved.pythonPath
}
```

Also suggested: do not keep the failure branch of `renderQrPng()` silent — write `exit code` / `err.stack` into `login-debug.log`, and change "the venv probably does not have qrcode yet" to "see exit/error in login-debug.log".

### Verification

```
spawn → python="<DSH_HOME>\bili-duty\.venv\Scripts\python.exe"
exit=0, PNG written
Dumping QR: ... (rendered as PNG)
Login OK, credential written to <DSH_HOME>\bili_credential.json
```

---

## Bug 2 (severe, users conclude "the settings are broken"): saving settings writes the **whole in-memory config** back to disk, so changing one key wipes a batch

### Symptom

- Flip one toggle in the settings page and a moment later it flips back; worse, **changing toggle A also changes toggle B** (as if they were mutually exclusive).
- The user keeps flipping the same toggle, and `duty.log` shows it three times in a row:

  ```
  settings updated: {"peakValley":true}
  settings updated: {"peakValley":true}
  settings updated: {"peakValley":true}
  ```

- Three on-disk sources contradict each other:

  | Location | `peakValley` | `replyToComments` |
  | --- | --- | --- |
  | plugin `config.json` | **false** | true |
  | host `cordis.patch.yml` | **true** | true |
  | plugin in-memory `cfg` (read back via the tool) | true | **false** |

### Root cause

`index.js:238`:

```js
const saveCfg = (patch) => { Object.assign(cfg, normalize(patch, cfg)); writeJson(cfgFile, cfg) }
```

`writeJson(cfgFile, cfg)` writes the **entire `cfg`**. And `cfg` carries the stale values produced by the Bug 1 read path, so when key A is changed, the stale B/C keys are written back to disk along with it.
Combined with the Bug 1 read path (startup snapshot wins), the next read returns the old values again — hence "change it, wait a moment, it reverts".

### Minimal fix

Fix both the read and the write side:

```js
// read: config.json as the base, then overlay the fresh user layer from the settings row
const out = { ...saved }
Object.assign(out, pickValid(row?.user))

// write: persist "what was already there + this patch", do not dump the whole in-memory cfg
const saveCfg = (patch) => {
  Object.assign(cfg, normalize(patch, cfg))
  writeJson(cfgFile, { ...DEFAULTS, ...readJson(cfgFile, {}), ...pickValid(patch) })
}
```

where `pickValid(src)` picks only legal scalars / string arrays according to the types in `DEFAULTS`.

> Note: 0.1.9 / 0.1.10 "local first" only changed the **read** side; `saveCfg` writing the whole `cfg` is **still there**, so "changing one wipes a batch" can still happen on 0.1.10.

---

## Bug 3 (blocks the last step): the desktop build cannot find `dsh`, and headless has no credentials — every duty round fails

### Symptom

Clicking "run one round", `duty.log` shows in order:

```
⚠️ cannot find dsh: the desktop build is usually not a global npm install ⇒ point "dsh path" in the settings to <app>/…/@deepseek-ai/dsh/lib/bin.js
'dsh' is not recognized as an internal or external command
duty finished (window:night, code=1)
```

After pointing "dsh path" at `<app>\resources\app.asar\node_modules\@deepseek-ai\dsh\lib\bin.js` by hand, the CLI starts (`Processing request of type ListToolsRequest`), but the next line is:

```
dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official";
store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it),
or export DEEPSEEK_API_KEY in the launching environment
duty finished (manual, code=1)
```

### Root cause (two parts)

1. **Finding dsh**: `resolveDsh()` (`index.js:610-640`) guesses three locations under `process.resourcesPath`:

   ```js
   ['app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
   ['app',              'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
   ['node_modules',     '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
   ```

   In the desktop build the CLI **exists only inside `app.asar`** (there is no `@deepseek-ai/dsh` under `app.asar.unpacked`), so all three miss and it falls back to `dsh`, which is not on PATH.
   Suggested addition: `['app.asar', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js']`.
   (The `process.execPath` + `ELECTRON_RUN_AS_NODE=1` spawn approach is correct — measured `--version` → `0.2.1-rc.2`, `exit=0`.)

2. **Headless missing credentials**: the `@deepseek-ai/dsh-headless` patch in DSH `0.2.1-rc.2` sets `credentials` / `authorization` / `deepseek-account` to `disabled: true`, so that round cannot read the key from the credential store (even though `DEEPSEEK_API_KEY` is right there in `.credentials.yaml`).
   **This was already fixed in 0.1.8** (the overlay re-enables those three entries), but this install came from the **plugin marketplace**, which served **0.1.7** — npm registry `latest` is still `0.1.7` while GitHub main is already `0.1.10`. So anyone installing from the marketplace / npm hits a bug that is already fixed upstream.

### Recommendations

- add the `app.asar` entry to `resolveDsh()`;
- **publish an npm version ≥ 0.1.8** (today `npm i dsh-bili-scroll` and the marketplace both deliver 0.1.7, which means every fix from 0.1.8–0.1.10 does not exist for those users);
- re-enable the three entries in the overlay (done in 0.1.8, repeated here for completeness):

  ```yaml
  - id: credentials
    disabled: false
  - id: authorization
    disabled: false
  - id: deepseek-account
    disabled: false
  ```

### Verification

```
duty start (manual): <app>\DSH NEXT.exe …\app.asar\node_modules\@deepseek-ai\dsh\lib\bin.js --profile headless …
Processing request of type ListToolsRequest
… (MCP tools actually ran, subtitles read, report written)
duty finished (manual, code=0)
picked 5 today (limit 5)
```

---

## Appendix: two minor issues (do not block the flow)

1. **The stub report stays in the final report**: `stubReportIfMissing(code)` writes a "this round produced no report" placeholder on the failing round; when the same round later succeeds and is appended into the same `out/<date>.md`, that failure note stays at the top of the report forever. Suggested: mark the placeholder as voided on success, or write placeholders to `out/<date>.failed.md`.
2. **The "the venv probably does not have qrcode yet" line** in the QR log sends users down the "reinstall the dependencies" dead end (measured here: the venv was fine). Suggested: neutral wording that includes the exit code.
