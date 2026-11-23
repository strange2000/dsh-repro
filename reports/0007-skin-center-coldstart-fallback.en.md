# "My skin is gone after every restart": one unretried load that swaps the user's choice for the default

> [中文](0007-skin-center-coldstart-fallback.md) · English

<!-- tl;dr-en -->
> **TL;DR** The setting is not lost — the load is. `~/.dsh/skin-center-active.json` still says `tight-sidebar`, `GET /api/skin-center/v2/active` still answers `tight-sidebar`, the skin files are intact, and the catalog returns 200. What fails is the first stylesheet request after a cold start: skin CSS goes through a lightningcss whitelist transform that forks a short-lived worker per request under a 10 s budget (`lib/index.js:1824`, `:1892`); the first request after mount measured **14.59 s**, so `serveStylesheet()` answered 500 `css-transform-failed`, and the renderer's `bootSkinRuntime()` catch calls `adopt(null, null)` exactly once and never retries (`lib/client.js:1768-1770`) → `removeAttribute('data-dsh-skin')` (`:1524-1538`) → official default. 9 of 9 cold starts over five days; 0 failures when switching skins without a restart. Verdict on 0.4.21: **DEFECT**.

Upstream issue: **[zhu1090093659/dsh-web#2085](https://github.com/zhu1090093659/dsh-web/issues/2085)**. The plugin itself lives in [zhu1090093659/dsh-skins](https://github.com/zhu1090093659/dsh-skins) under `packages/skins/skin-center` (`@linxin666/dsh-client-ui-skin-center` 0.4.21).

## In one breath

The user says: "every restart puts my skin back to the default, the one I picked is gone."

That sentence invites one assumption — *the setting was not saved* — and the measurements refuse it. The choice survived every time; what dies is **the one load attempt on the boot path**.

Skin CSS is not served raw: it runs through a CSS safety pipeline (lightningcss whitelist transform) that **forks a short-lived worker per request**, with a **10 s** budget. The first request after a cold start measured **14.59 s** → over budget → `500 css-transform-failed`. The renderer's catch does a single `adopt(null, null)` with no retry → `removeAttribute('data-dsh-skin')` → official default.

So the same unchanged choice applies fine on the second (warm) load and is thrown away on the first (cold) one.

## Why this is not "the setting got reset"

| Evidence | Measured |
|---|---|
| `~/.dsh/skin-center-active.json` (238 B) | `{"active":"tight-sidebar","initialized":true,...}` — the choice is there |
| `GET /api/skin-center/v2/active` (in-process, at failure time) | returns `tight-sidebar` |
| `GET /api/skin-center/v2/catalog` | 200 |
| `~/.dsh/skins/tight-sidebar/` | `skin.css` + 16 KB `patches.css`, intact |
| Host log | the same `stylesheet load failed` line on every cold start |

Persistence, routing, disk and the skin directory are all fine. One thing is left: **the renderer gives up after a single failed load**.

## The scene

Host log `~/.dsh/logs/desktop-next-<date>.0.jsonl`, identical on every cold start:

```
[skin-center] switch to tight-sidebar failed; previous skin intact
Error: stylesheet load failed: api/skin-center/v2/skins/tight-sidebar/stylesheet
```

Counts: **9 failures across 5 dates** (11-16 ×1, 11-17 ×2, 11-18 ×1, 11-20 ×4, 11-23 ×1) — that is every cold start in the 6 log files on this machine, not a flake.

One timeline (11-23, `runId abc8cb61-…`, `seq 92`):

| Time | Event |
|---|---|
| 06:51:51 | process start |
| 06:52:10–19 | plugins mounted |
| 06:52:38 | web ready |
| 06:52:42 | host ready |
| 06:52:56 | renderer up |
| 06:53:10 | kernel second apply (`patch: entry ... not found`) |
| 06:53:12 | stylesheet request fails |

~80 s after launch: not a first-frame race, not user-triggered — **the single attempt on the boot path**.

## Control experiment: 0 failures in a warm process

Hammering the same process (`127.0.0.1:48611`) right after the plugin mounted:

| Request | attempt 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| `GET …/skins/tight-sidebar/patches` | **14.59 s** | 0.331 s | 1.382 s | 0.644 s |
| `GET …/skins/tight-sidebar/stylesheet` | 0.764 s | 0.315 s | 1.825 s | — |

1. **14.59 s vs a 10 s budget** — the first request is cut off by the budget, not rejected by the whitelist (that would be 422 `css-whitelist-violation`; the log says 500).
2. **Warm requests are all under 2 s** — the cost is worker cold start, not CSS complexity.
3. **Switching skins without restarting never fails** — so this is not "the skin files broke", it is "boot gets exactly one shot".

## Decide it with one command

```bash
node repro/skins-coldstart/audit-coldstart.cjs            # auto-discovers ~/.dsh/profiles/<profile>/node_modules/@linxin666/dsh-client-ui-skin-center
node repro/skins-coldstart/audit-coldstart.cjs --selftest # proves the ruler separates defect shape from fixed shape (offline)
```

| Check | What it looks at | Fixed shape |
|---|---|---|
| **A (deciding)** | any loop / backoff / retry within 600 chars before the `adopt(null, null)` fallback | present — e.g. 1 s / 3 s / 6 s, then fall back |
| **B (deciding)** | `SKIN_CSS_REQUEST_TIMEOUT_MS` widened (≥ 30 s), or worker prewarm present | widened or prewarmed — the cold-start request is no longer cut off |
| C (corroborating) | `stylesheet load failed` count and dates in the host log | nothing new on the fixed build (history only, wrong on its own) |
| D (corroborating) | whether `active` is non-empty in `skin-center-active.json` | non-empty — the choice never left |

Verdicts: `FIXED` (A present) / `PARTIAL` (budget widened or prewarmed only — a single failure still falls back) / `DEFECT` (neither).

The `--selftest` is not decoration: it feeds a synthetic defect-shaped and fixed-shaped `bootSkinRuntime`, both budget constants, and a synthetic log line to the same predicates and requires them to answer differently. If the ruler cannot separate the two shapes, a real-machine verdict means nothing.

## Measured (2026-11-23, Windows 11 + DSH NEXT 0.4.21)

```
skin-center cold-start fallback · read-only audit

plugin dir : ~/.dsh/profiles/<profile>/node_modules\@linxin666\dsh-client-ui-skin-center
version    : 0.4.21
  ❌ [A] 落默认前无循环/退避/重试：一次性 adopt 失败即清皮肤
  ❌ [B] 预算仍是 10000ms（冷启动首请求实测 14.59s 打不住）
  verdict: DEFECT

host logs  : ~/.dsh/logs (6 .jsonl)
  ❌ [C] stylesheet load failed ×9，switch failed ×9，日期：2026-11-16 / 2026-11-17 / 2026-11-18 / 2026-11-20 / 2026-11-23
  ❌ [D] active=null（initialized=true）

note: [C] is corroborating (history only); the verdict comes from [A], [B] says whether the budget masks it.
脚本不改任何文件、不改配置；--probe 是唯一会联网的选项，且只打本机 GUI。
(Paths above are normalized to `~/.dsh` / `<profile>` with the local username removed; everything else is verbatim.)
```

`[D]` reads `active=null` because **the user had already switched back to the official default by the time this was written** (to screenshot the default look) — not part of the failure. At failure time both `active` and `GET /active` were `tight-sidebar`; see the table above.

## Where the code is

Upstream (zhu1090093659/dsh-skins):

- `packages/skins/skin-center/src/client/runtime/boot.ts:234-238` — the boot `adopt` catch does one `adopt(null, null).catch(() => {})`

0.4.21 build (`@linxin666/dsh-client-ui-skin-center`):

- `lib/client.js:1684-1771` `bootSkinRuntime()`: `refreshCatalog()` → `GET /active` → `controller.adopt()`; `:1768-1770` catch does only `await controller.adopt(null, null)`
- `lib/client.js:1524-1538`: `currentActivation === null` (always true on boot) → `removeAttribute('data-dsh-skin')`
- `lib/index.js:1822` `SKIN_CSS_MAX_OUTSTANDING = 8`, `:1824` `SKIN_CSS_REQUEST_TIMEOUT_MS = 1e4`, `:1892` `this.timeoutMs = options.timeoutMs ?? 1e4`
- `lib/index.js:2697-2736` `serveStylesheet()`: `SkinCssSafetyError` → 422; `Overloaded` → 503; everything else (incl. `SkinCssTransformTimeoutError: skin CSS safety transform timed out after 10000ms`) → 500
- `lib/index.js:3765-3768` config schema has `skin-background` / `skin-custom-theme` only — no timeout or retry knob

## Smallest fix

1. **Real fix**: retry in the `boot.ts` catch — 1 s / 3 s / 6 s, then fall back (reuse the same controller).
2. **Cheap fix**: widen `SKIN_CSS_REQUEST_TIMEOUT_MS` from `1e4` to `3e4`–`6e4`, or prewarm one CSS transform worker after the plugin mounts (14.59 s cold vs < 1.4 s warm).
3. **User-side workaround**: click "use" again in the skin center after a restart, or reload the web GUI. The choice is still there; it just needs re-applying.

## Status

- Upstream issue [#2085](https://github.com/zhu1090093659/dsh-web/issues/2085): open.
- This machine, 0.4.21: **DEFECT** (no retry, budget unchanged).
- The material stays useful as a **regression detector**: on a downgraded plugin or another machine, run the auditor once and you know whether this came back.
