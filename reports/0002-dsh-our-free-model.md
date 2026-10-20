# GitHub Issue 草稿 · 精简版（正文 约 2.6K 字符，远低于 65536 上限）

## Title

```
In-app upgrade always rolls back on DSH Desktop: hot reload can never confirm a new version (activation version mismatch)
```

---

### Summary

On **DSH Desktop** (Electron host), the in-app **立即升级** button fails on **every** version and the failure rolls the working install back. It is not network or signature: staging, verification, backup, install and re-read verification all succeed. Only the hot-reload activation fails, and the current code turns "cannot reload in-process" into "abort the whole upgrade".

### Environment

- DSH Desktop 2.0.17 (Electron), cordis 4.0.4, `dsh-llm` / `dsh-commands` / `dsh-credentials` 0.2.0-rc.2
- Windows 11 x64, Node v24.21.0
- Plugin installed from npm; reproduced 2.1.0→2.3.0, 2.3.0→2.4.0, 2.1.0→2.5.0, 2.5.0→2.5.1

### Reproduction

1. Settings → Our Free Model → 免费模型 tab → scroll to bottom → 插件升级 → 检查更新 → 立即升级
2. UI reports: `upgrade failed, previous files restored (re-import failed, old code still running (activation version mismatch: expected 2.5.1, got 2.5.0))`

### Evidence

Host log (`%APPDATA%\DSH Desktop\logs\host\dsh-*.log`), every attempt:

```
17:20:51.099 [I] [our-free-model] our-free-model: hot reload purging 0 cached module(s)
```

`upgrade-state.json` (one per version, same shape):

```json
{"from":"2.5.0","to":"2.5.1","phase":"rolled-back","diskRestored":true,"runtimeRestored":true,
 "error":"upgrade failed, previous files restored (re-import failed, old code still running (activation version mismatch: expected 2.5.1, got 2.5.0))","activated":false}
```

`diskRestored: true` is the point: the disk had **already** been upgraded and verified before the rollback undid it.

### Root cause

1. `src/reload.js:172-174` — `purgeCaches(loader.internal, packageUrl)` finds `0` modules: the desktop loader exposes no enumerable ESM cache.
2. `src/reload.js:189-198` — the fallback re-imports with `freshUrl.searchParams.set('ofm-reload', …)`. The loader keys its cache by **resolved path**, so the query is normalized away and `import()` returns the already-evaluated module. `replacement.version` is therefore still the pre-upgrade version (that is why `got` always equals the old version).
3. `src/reload.js:207-209` throws `activation version mismatch`; `src/updater.js:985-987` re-raises; `src/updater.js:996` calls `restoreBackup()` and discards a fully installed, verified upgrade.

The asymmetry: `apply({ version, activate })` treats `activate` as **optional** (`:977 if (activate !== undefined)`). Omitting it is a supported path — it ends at `phase: 'complete', activated: false` with the new files in place, activated by the next restart. That path works perfectly on this machine: driving the plugin's own primitives (`downloadManifest` + `parseManifest` + `verifyManifestSignature` + `stageRelease` + `verifyStaged` + `installStaged` + `verifyInstalled`) with `activate` omitted upgraded this install 2.1.0 → 2.3.0 → 2.4.0 → 2.5.0 → 2.5.1 → 2.5.2, every file byte-identical to the signed manifest, and after a full relaunch the log shows `update check … -> 2.5.2 (installed 2.5.2)`. So restart alone is a complete activation.

### Proposed fix

Add a third outcome — *installed, restart required* — instead of `throw` → rollback:

- `updater.js`: let `activate()` return `{ ok: true, version, deferred: true }`; on `deferred` set `activated = false`, `phase: 'complete'`, persist `restartRequired: true`, and **skip `restoreBackup()`**. Expose `restartRequired` from `status()`.
- `index.js`: when `selfReload()` returns `{ ok: false, error: /re-import failed|activation version mismatch/ }`, return `{ ok: true, version: installed.version, deferred: true }` instead of letting it kill the upgrade.
- `client.js`: when `restartRequired`, say "已写入 X，请完全退出并重新打开 DSH 生效" instead of "已升级到 X，插件已热重载生效".

I have a full diff ready and can open a PR if you prefer.

### Workaround meanwhile

Run the same primitives with `activate` omitted, then fully quit and relaunch the app.

### Minor

`src/reload.js:175-179` writes a diagnostic marker into `globalThis` when `backup.esm.size === 0`, but nothing ever reads it — the one signal that says "this host cannot evict modules" is silently discarded. A warning log would be more useful.
