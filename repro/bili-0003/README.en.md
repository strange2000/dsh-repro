# bili-0003: three bugs that make the desktop install unusable out of the box

> [中文](README.md) · English

Upstream project: [c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll).
The full report is in [`../../reports/0003-dsh-bili-scroll.md`](../../reports/0003-dsh-bili-scroll.md).

The three bugs are independent, but each one blocks "usable for the first time":

| # | Symptom | Root cause in one line |
|---|---|---|
| 1 | Clicking "QR login" does nothing, no QR code appears | `pythonPath` gets pushed back to `"python"` by the host's boot-time snapshot ⇒ spawns the Microsoft Store stub (exit 9009), and the QR rendering failure is swallowed silently |
| 2 | Flipping one setting changes another one | `saveCfg()` writes **the entire in-memory cfg** back to disk ⇒ stale keys ride along |
| 3 | "Run one round" always fails | the desktop CLI lives only inside `app.asar` (all three hardcoded candidates miss) + the headless overlay disables three services including `credentials` |

## Usage (read-only)

```bash
node audit-config.cjs                    # plugin / state dir / profile patch discovered at default locations
node audit-config.cjs --plugin <plugin dir>
node audit-config.cjs --state <state dir> # defaults to ~/.dsh/bili-duty
node audit-config.cjs --patch <cordis.patch.yml>
node audit-config.cjs --json
node audit-config.cjs --selftest         # validate the decision function first (offline)
```

It does not start the plugin, does not run a round, and does not modify any config. It reads sources, reads three state files, and probes for paths (existence only).

## The four output sections

**1. Source**: each bug maps to one decidable code path

| Item | What decides it | Defect | Fixed |
|---|---|---|---|
| B1 | the host baseline in `loadCfg()` | `const out = { ...hostCfg() }` (the snapshot taken at `apply()`) | `normalize(row.value …)` (the current settings row) |
| B1b | is `pythonPath` local-first / does it fall back to a venv | neither ⇒ the host's `"python"` wins | listed as local-first, or a `venvGuess` fallback exists |
| B2 | does `saveCfg()` write the whole object back | `writeJson(cfgFile, cfg)`, no provenance marker | patch-only writes, or a `_set` provenance marker |
| B3 | how it locates the `dsh` CLI | three hardcoded candidates (`app.asar.unpacked` / `app` / `node_modules`) | resolver + npm global + bounded recursion over the app directory |
| B4 | does the overlay re-enable the three services | `credentials`/`authorization`/`deepseek-account` still `disabled: true` | all three set to `disabled: false` |

`·` means reference-only and excluded from the verdict (for example B2's `_set`: it is not a root fix, but it does block the "stale keys written back and read again" cycle).

**2. Three-way field comparison**: the same keys side by side from `config.json`, the host's `cordis.patch.yml`, and `local-override.json` — a direct check whether "change one, clobber a bunch" is recurring. A key present in `local-override.json` means that particular `settings.update` never reached the host (a residue of the desktop profile-reload limitation).

**3. `pythonPath` probing**: the value in `config.json`, the real venv path, and whether a bare `"python"` would be spawned.

**4. How to verify it yourself**: `grep -n "spawn → python" duty.log`, and the `resolveDsh()` return value shown on the settings page's self-check row.

## Measured (Nov 2026, Windows 11 + DSH NEXT desktop, my machine)

```
plugin version: 2.5.0
  ✅ [B1]  baseline is row.value
  ✅ [B1b] pythonPath is in the local-first list
  · [B2]   still writes the whole cfg, but with a _set marker (partial mitigation, not a root fix)
  ✅ [B3]  resolver + npm global + bounded recursion over the app directory
  ✅ [B4]  all three ids set disabled: false
  subtotal: 4/4 decisive items pass → FIXED

3. pythonPath: …\\bili-duty\\.venv\\Scripts\\python.exe (exists) → OK
2. three-way comparison: perDay / peakValley / autoComment / dmMode / pythonPath / workspace / replyToComments all agree
```

So all three bugs are fixed as of 2.5.0 on this machine. The one loose end is B2's whole-object write — intercepted by `_set` plus `local-override.json`, but the write path itself was never narrowed to "patch only".

One fact that still holds upstream: the install that filed the issue came **from the plugin marketplace** and delivered `0.1.7`, while GitHub main was already at `0.1.10` — meaning anyone installing from the marketplace reliably hits bugs that were already fixed. A "published package behind the source" gap hurts more than the bug itself, and reproduction material is what lets the two be told apart.
