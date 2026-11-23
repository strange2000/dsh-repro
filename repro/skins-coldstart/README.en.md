# skins-coldstart: the stylesheet request times out into a 500 on cold start, and boot never retries

> [中文](README.md) · English

Upstream: **zhu1090093659/dsh-web** — issue [#2085](https://github.com/zhu1090093659/dsh-web/issues/2085). The plugin itself lives in zhu1090093659/dsh-skins under `packages/skins/skin-center` (`@linxin666/dsh-client-ui-skin-center` 0.4.21). Full report: [reports/0007](../../reports/0007-skin-center-coldstart-fallback.en.md).

## What the defect looks like

The user's words: "why does every dsh restart put my skin back to the default, and my own skin stops working?"

Three facts answer it:

- **The choice was never lost.** `~/.dsh/skin-center-active.json` kept `{"active":"tight-sidebar"}`, `GET /api/skin-center/v2/active` kept answering `tight-sidebar`, the skin files were intact, catalog returned 200.
- **What is lost is the cold-start load.** Skin CSS goes through a lightningcss whitelist transform that **forks a short-lived worker per request** under a **10 s** budget (`lib/index.js:1824` / `:1892`); the first request after mount measured **14.59 s** → `serveStylesheet()` answers `500 css-transform-failed`.
- **The renderer does not retry.** `bootSkinRuntime()`'s catch does a single `adopt(null, null)` (`lib/client.js:1768-1770`) → `removeAttribute('data-dsh-skin')` (`:1524-1538`) → official default.

So the same unchanged choice applies on the second (warm) load and is thrown away on the first (cold) one — which the user experiences as "my skin got reset".

## Why there is no one-click repro

The precondition is **a cold start whose first request blows the budget**, and neither can be produced by clicking: in a warm process every switch succeeds (14.59 s on the first request, then 0.331 / 1.382 / 0.644 s), and once anything is warm the defect disappears. So this ships a **judge** instead, answering a plainer question: **on my machine and this version, will a cold start still throw my skin away?**

## Usage

```bash
node audit-coldstart.cjs                  # auto-discovers ~/.dsh/profiles/<profile>/node_modules/@linxin666/dsh-client-ui-skin-center
node audit-coldstart.cjs --dir <plugin>    # explicit install dir (several versions installed)
node audit-coldstart.cjs --logs <dir>      # log dir (default ~/.dsh/logs)
node audit-coldstart.cjs --active <file>   # explicit skin-center-active.json
node audit-coldstart.cjs --probe [url]     # only networked option: hits the local GUI and times the first request
node audit-coldstart.cjs --json            # machine-readable
node audit-coldstart.cjs --selftest        # judge self-test only (6 synthetic cases), does not scan
```

Zero dependencies, read-only: it does not load plugins, does not talk to the host, writes nothing. Exit `0` = scan completed (**defect or not does not affect the exit code**), `1` = `--selftest` failed, `2` = bad argument or environment.

## Checks

| Check | What it looks at | Fixed shape |
|---|---|---|
| **A (deciding)** | any `for` / `while` / `retry` / `backoff` / `attempt` / `setTimeout` / `sleep` within 600 chars before the `adopt(null, null)` fallback | present — e.g. 1 s / 3 s / 6 s, then fall back |
| **B (deciding)** | `SKIN_CSS_REQUEST_TIMEOUT_MS` ≥ 30000, or `prewarm` present | widened or prewarmed — the first request is no longer cut off |
| C (corroborating) | `stylesheet load failed` / `previous skin intact` counts and dates in `~/.dsh/logs` | only says "it really did happen on every cold start"; not part of the verdict |
| D (corroborating) | `active` in `skin-center-active.json` | non-empty — the choice never left |

Verdicts: `FIXED` (A present) / `PARTIAL` (budget widened or prewarmed only — one failure still falls back) / `DEFECT` (neither).

## Measured here (2026-11-23, profile `desktop`, Windows 11 + DSH NEXT 0.4.21)

```
skin-center cold-start fallback · read-only audit

plugin dir: C:\Users\stran\.dsh\profiles\desktop\node_modules\@linxin666\dsh-client-ui-skin-center
version   : 0.4.21
  [FAIL] [A] 落默认前无循环/退避/重试：一次性 adopt 失败即清皮肤
  [FAIL] [B] 预算仍是 10000ms（冷启动首请求实测 14.59s 打不住）
  verdict: DEFECT

host logs: C:\Users\stran\.dsh\logs (6 .jsonl)
  [FAIL] [C] stylesheet load failed ×9, switch failed ×9, dates: 2026-11-16 / 11-17 / 11-18 / 11-20 / 11-23
  [FAIL] [D] active=null（initialized=true）

note: [C] is corroborating (history only); the verdict comes from [A], [B] says whether the budget masks it.
The script writes nothing and changes no config; --probe is the only networked option and only hits the local GUI.
```

(The console output itself is Chinese — quoted verbatim above. `[D]` reading `active=null` has a background: by the time this was written the user had **already switched back to the official default** by hand, to screenshot the default look — not part of the failure. At failure time both `active` and `GET /active` were `tight-sidebar`, which is exactly why D is corroborating and not deciding.)

Self-test (`--selftest` — can the judge separate defect shape from fixed shape?):

```
  ok A defect shape  => no retry
  ok A fixed shape   => retry present
  ok B defect shape  => budget 10000
  ok B fixed shape   => budget 60000, counted as widened
  ok C log scan      => counted 1 line
  ok D active parse
selftest: 6/6 passed (the judge separates defect shape from fixed shape)
```

## Limits (important)

- **A is lexical.** If upstream moves the retry inside `adopt()` or into a `queueMicrotask` / `Promise` chain, A reports "no retry" — look at the code before believing it.
- **B only reads the constant.** If the fix prewarms centrally or adapts the budget at runtime, the constant stays `1e4` while no longer being fatal, and B over-reports; trust the actual restart experience plus C there.
- **C reads history.** Old failures still count after an upgrade; it only answers "how often did this machine hit it".
- **It does not judge the whitelist.** A whitelist rejection is 422 `css-whitelist-violation` and is a different bug from this 500 timeout; the script does not rate whether a skin's CSS is compliant.

## One line

The line is "my skin got reset"; the truth is "the skin was dropped on load — boot gets exactly one shot, and that shot ran 10 s over budget".
