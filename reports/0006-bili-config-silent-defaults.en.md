# Written down, but not in effect: three "silent degradations", each correct on its own

> [中文](0006-bili-config-silent-defaults.md) · English

<!-- tl;dr-en -->
> **TL;DR** Three separate issues in one plugin, filed weeks apart, turn out to share one shape: a component cannot read, cannot write, or cannot count — and in every case it **silently substitutes a default for the truth**. (#78) `parseSeenTable()` accepted table rows only, so a `seen.md` written in any other layout was unreadable: not one of 100+ records parsed, the "videos it has scrolled" panel stayed empty, no error. (#79) `POST /api/bili-duty/config` rebuilt the patch from a hand-written 1.x allowlist, so 2.x fields (`dmWatch` / `favFolderId` / `personaPrompt`) were dropped on save, and the panel's 5-second poll flipped the toggle back; the same save also carried `{"keywords":[]}`, wiping the user's keyword list. (#80) With `reportLevel=off` there is no report file to count, so `countPickedToday()` returned 0 forever, the `perDay` gate never fired, and a limit of 5 produced 10 picks in a day while the panel still showed 0. Diagnostic proof for #79 was differential: the MCP `bili_config` tool bypassed the whitelist, so on the same machine the tool could write and the panel could not. All three are fixed as of 2.5.0 (auditor verdict FIXED, 7/7 decisive items); the residual is that `saveCfg()` still writes the whole in-memory object, which `_set` and `local-override.json` intercept but do not remove.

They correspond to three upstream issues: [#78](https://github.com/c1overzz/dsh-bili-scroll/issues/78) (the seen table cannot be read), [#79](https://github.com/c1overzz/dsh-bili-scroll/issues/79) (the panel saves, but nothing is saved), [#80](https://github.com/c1overzz/dsh-bili-scroll/issues/80) (the limit does not hold). They sit in **read**, **write** and **count** respectively, and were filed weeks apart. They are one report because reading the source shows one and the same move:

> cannot read → treat as absent; cannot write → treat as unchanged; cannot count → treat as 0.

Every step is "correct by its own logic", and every step stays quiet. Together, the user sees "I changed it and it does not take" plus "it says nothing was picked, when it picked videos all day".

## Symptom

| issue | What the user sees | What actually happens |
|---|---|---|
| #78 | The "videos it has scrolled" panel is always empty | `parseSeenTable()` assumes `seen.md` is a fixed-column table; the charter never specified a layout, and not one of the user's 100+ records came through |
| #79 | Change a setting, five seconds later it flips back; keywords occasionally wiped | `POST /config` rebuilds the patch from a 1.x-era allowlist, so fields added in 2.0 (`dmWatch` / `favFolderId` / `personaPrompt`) are filtered at the entry; the same save also carries `{"keywords":[]}` |
| #80 | Limit set to 5, ten picks in a day; the panel's `pickedToday` shows 0 | With "no daily report" there is no report file to count ⇒ `countPickedToday()` is always 0 ⇒ the `perDay` gate never closes; the floor only constrains timed windows, and `runDuty('manual')` is not constrained |

The common point is the same sentence again: **no error**. No exception, no stack, no warning, only "the number in the UI is wrong" — and a wrong number is the first thing people attribute to their own memory.

## Criterion: one auditor, three conclusion items

`repro/bili-0003/audit-config.cjs` originally judged only the three bugs of 0003 (unusable right after install); T14 extended it to judge these three. Conclusion items decide the verdict; reference items are only corroboration.

| Item | What it judges | Defective shape | Fixed shape |
|---|---|---|---|
| **B5** | How the seen table is parsed (#78) | Assumes BV sits in a fixed column and hard-parses one date format, silently dropping bad rows | BV located by `findIndex` scanning, dates via the lenient `seenDay()`, bad rows counted and logged when the count changes |
| **B6** | The whitelist of the config write channel (#79) | Hand-written `ALLOW` array ⇒ new fields silently filtered | Derived from `Object.keys(DEFAULTS)`; plus blank-value protection (a blank does not overwrite an existing value; clearing must be an explicit `clear`) |
| **B7** | What is counted when `reportLevel=off` (#80) | Counts report files only ⇒ always 0 | Falls back to counting "today + picked" rows in `seen.md` |
| **B7b** | Whether manual rounds are accounted separately (reference) | Manual picks eat into the day's automatic quota | `manualExtra` is listed separately and `autoPickedToday()` subtracts it |

`--selftest` now runs **18 per-item assertions**: every defective shape must judge false, every fixed shape must judge true. The extension's first run failed 5 items and caught three bugs in the judge itself (a function signature with parentheses in the parameter list could not be extracted, the B6 regex accidentally matched a different `Object.keys(DEFAULTS)`, and the reference item B2 was asserted as a conclusion item). **The ruler had to break once before the verdict could be trusted.**

## Measured on this machine (2026-11-08, `dsh-bili-scroll` 2.5.0, Windows 11 + DSH NEXT desktop)

```
✅ [B1] basis moved to row.value      ✅ [B5] BV findIndex + seenDay + bad-row count
✅ [B1b] pythonPath local first       ✅ [B6] whitelist from DEFAULTS + blank guard
· [B2]  still writes everything, now with _set  ✅ [B7] falls back to seen.md when no report
✅ [B3] resolver + bounded recursion  · [B7b] manualExtra present
✅ [B4] three services disabled: false
subtotal: 7/7 decisive items pass → FIXED
```

Three-way config comparison (plugin `config.json` / host `cordis.patch.yml` / `local-override.json`) agrees on all seven keys: `perDay` / `peakValley` / `autoComment` / `dmMode` / `pythonPath` / `workspace` / `replyToComments`. `config.json` records 16 keys under `_set`, i.e. keys the plugin panel owns.

But one line must be kept **as evidence**: `local-override.json` still holds 8 keys (`keywords`, `dmWatch`, `dmWatchMinutes`, `dmOwnerUid`, `dmMode`, `personaPrompt`, `peakValley`, `mentionName`). The existence of that file is itself the criterion — keys in there mean that particular `settings.update` never reached the host (a limitation of profile reload on the desktop build), so the plugin could only record them locally.

## The fix: remove the silence, not correct the default

None of the three is "computed wrong"; all three are **wrong without saying so**. So the fix is not about adding branches, it is about letting every layer say what it dropped.

**Read side (#78)**: the parser must tolerate irregular input **and bad rows must be counted and reported**. The first version's "`continue` on any unrecognised line" was the problem itself; the current shape is: it may fail to read, it may not fail to know.

**Write side (#79)**: the whitelist must be derived from a **single source of truth** (`DEFAULTS` is that list) instead of maintaining a mirror. Blank values need separate handling: `""` and "not filled in" are two different things, and clearing must be explicit (`clear: [...]`). After a write it must be possible to report "which keys the host did not accept" — `local-override.json` is that report.

**Count side (#80)**: every count needs a fallback source and must distinguish "really 0" from "I cannot read it". `0` is the most dangerous default: it means both "it did not happen" and "I do not know".

**One more for the host layer**: states like `local-override.json` ("staged locally, host never accepted it") deserve a user-visible hint. Today it is a file whose meaning only the author knows — a clue while debugging, silence in daily use.

## Limits

- The auditor **judges shape, not semantics**: it confirms "BV is located by scanning", "the whitelist is derived from DEFAULTS"; it cannot prove a particular `seen.md` parses correctly. Verifying semantics means running real data, which is a different exercise.
- **The two `·` items are not fixes**: B2 still writes everything (`_set` only blocks the "stale keys written back and read again" loop), and B7b only changes how the accounting is kept. Such partial mitigations are marked `·` in the index and do not count as passing.
- 2.5.0 on this machine is fixed, so the long-term value of these auditors is **rollback detection**: after a downgrade, or on another machine still on an old version, one command says which item came back.
- The issue was filed against `0.1.7` installed from the plugin marketplace while GitHub main was already at `0.1.10`. **"The marketplace lags the source" hurts more than the bug** — users reliably hit problems that are already fixed, and then read "fixed" as "not fixed".
