# ofm-0002: every in-app upgrade rolls back (hot reload can never confirm the new version)

> [中文](README.md) · English

Upstream project: [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model).
The full report is in [`../../reports/0002-dsh-our-free-model.md`](../../reports/0002-dsh-our-free-model.md).

## What the defect looks like

An Electron-based desktop host cannot enumerate the ESM cache, so:

1. `purgeCaches()` purges **0** modules (`hot reload purging 0 cached module(s)`);
2. the fallback re-`import()`s with an `?ofm-reload=` query, but the loader keys its cache by **resolved path**, so the query is normalised away ⇒ the already-evaluated old module comes back;
3. `replacement.version` is still the old version ⇒ `activation version mismatch` → `throw`;
4. the updater treats "hot activation failed" as "the whole upgrade failed" ⇒ `restoreBackup()`, undoing an upgrade that was **already installed and signature-verified byte by byte**.

So the symptom is "every upgrade fails", while `upgrade-state.json` says `diskRestored: true` — the disk was upgraded successfully and the rollback took it away.

## Why there is no one-click repro script

A real reproduction means actually running an upgrade and letting it roll back, and the blast radius of this defect is **the user's own installation**. So what ships here is a **read-only audit**: it answers the same question ("will my copy still do this?") at zero cost.

```bash
node audit-activation.cjs                  # finds ~/.dsh/profiles/*/node_modules/dsh-our-free-model
node audit-activation.cjs --dir <plugin dir>
node audit-activation.cjs --logs           # also count evidence lines in host logs (skips if absent)
node audit-activation.cjs --json
node audit-activation.cjs --selftest       # validate the decision function first (offline)
```

It does not execute plugin code, does not touch the network, and does not write into the plugin directory: it only reads `src/reload.js`, `src/updater.js` and `upgrade-state.json`.

## What it checks

| Item | Looks at | Fixed shape |
|---|---|---|
| A | the `backup.esm.size === 0` branch | `return { restartRequired: true }` — stop, do not attempt the re-import |
| B | the `activation version mismatch` assertion (**reference only**) | the throw usually still exists, but A intercepts first, so desktop hosts never reach it; judging on B alone gives a false negative |
| C | whether the `updater` knows `restartRequired` | known = deferred activation landed; unknown = any hot-reload failure still ends in `restoreBackup()` |
| D | whether `activate` is optional (reference only) | `if (activate !== undefined)` — omitting `activate` was always a supported path |

Three verdicts: `FIXED` (deferred activation landed) / `PARTIAL` (half fixed) / `DEFECT` (still rolls back).

**`--selftest` is not decoration**: it builds a synthetic source for the defect version and one for the fixed version, feeds both to the same decision function, and requires `DEFECT` and `FIXED` respectively. If the auditor cannot even separate those two shapes, a verdict on a real install means nothing.

## Measured (Nov 2026, Windows 11, my machine)

```
plugin dir: ~/.dsh/profiles/desktop/node_modules/dsh-our-free-model
version: 2.8.3
  ✅ [A] that branch returns { restartRequired: true } — no further re-import
  · [B] throw still present (expected: A intercepts, so this path is unreachable)
  ✅ [C] restartRequired field/flag appears in the updater
  · [D] omitting activate is a supported path
  subtotal: 2/2 decisive items pass
  verdict: FIXED

upgrade-state.json: 2.1.0 → 2.5.3, phase=complete  activated=false
  ⭐ this is the "installed, not hot-activated yet, waiting for restart" shape —
    what the fixed version is supposed to look like, not a failure.
```

In other words: **the issue is fixed on 2.8.x**, and the fix is the one the report suggested (treating "installed but not hot-activated" as a normal outcome rather than an error). The old `phase: rolled-back` + `diskRestored: true` shape no longer appears.

`--logs` scanned 14 log files on this machine with 0 hits — the old logs had already rotated, so logs count as corroboration only; the primary evidence is the source and the state file.

## The equivalent "work around it" path (supported, but it does touch your install)

The conclusion in the report: the same pipeline succeeds if you **skip only the hot-activation step**; it takes effect after a restart.

```js
// Illustrative only: use your version's exported names. This really writes to disk — do not run it on a machine you do not understand.
const { downloadManifest, parseManifest, verifyManifestSignature } = updater.deps   // names vary by implementation
const manifest = parseManifest(downloadManifest(await fetchLatestIndex()), targetVersion)
verifyManifestSignature(manifest)
// ...stageRelease / verifyStaged / installStaged / verifyInstalled unchanged
await apply({ version: targetVersion })      // ⚠️ no activate
// then quit DSH completely and reopen it — the startup path activates the new version
```

When `activate` is omitted the pipeline stops at `phase: 'complete'` / `activated: false` with the files already on disk and verified, and the next launch activates them. That is exactly why A and C are the decisive items: the fixed version makes this path the default outcome.
