# chorography T1 auditor · the asar path in `locateCliJs()`

> 中文 · [English](README.en.md)

Upstream: [slow-stack/mneme#578](https://github.com/slow-stack/mneme/issues/578) — at 0.11.0 the chorography T1 headless runner built its CLI entry from one **hardcoded** path, which makes T1 unusable on DSH NEXT Desktop. All you see is `headless exit code 1: (no output)`.

Why this one is hard to catch:

> It has no stack. The spawned process is handed an entry point that does not exist, so it dies before anything could throw; chorography captures stderr into the result object, and "no output" reads as "it failed, cause unknown".

```bash
node audit-t1-locate.cjs                                  # find mneme and the install automatically
node audit-t1-locate.cjs --exe "D:/DSH NEXT/DSH NEXT.exe"
node audit-t1-locate.cjs --asar "D:/DSH NEXT/resources/app.asar"
node audit-t1-locate.cjs --json
node audit-t1-locate.cjs --selftest
```

Zero dependencies, read-only: sources via `readFileSync`; `app.asar` is read **only through its header** (directory index, nothing extracted, nothing written), and no host process is spawned. Exit codes: `0` = audit ran, `1` = self-check failed, `2` = bad argument or environment.

## What it judges

| Item | Criterion | Weight |
|---|---|---|
| **A** the CLI locator (`locateCliJs`, renamed `resolveCliJs`) has candidates / probing | candidate array, loop over paths, or a mention of the real `desktop-cli` entry; the function is looked up **by a list of names**, not one | verdict |
| **B** can read inside the asar | `original-fs` / `@electron/asar` / `extractFile` | reference |
| **C** returns `null` when it cannot locate | triggers the `kind: "environment"` fallback instead of handing out a bad path | reference (supports A) |
| **D** `locateDshExe` knows the DSH NEXT exe | only `deepseek harness.exe` + `Program Files\DeepSeek Harness` ⇒ it does not; a `DSH NEXT` directory name or a `DSH_EXE` override also counts | verdict |
| **measured** does the hardcoded path exist in the real install | zero-dep asar header walk | verdict (decides `DEFECT`) |

Verdicts: `FIXED` (already candidate/probe shaped) · `DEFECT` (hardcoded and the path does not exist) · `SUSPECT` (the path happens to exist, no install found to verify, or the source shape could not be judged), each with the reason. `SUSPECT` also covers "no function body found under `locateCliJs` / `resolveCliJs` / `resolveCliPath`" — upstream renames land there, which is why the lookup now takes a list of names.

## Measured here (2026-11-08, mneme `0.12.0`, DSH NEXT Desktop)

```
source   A MISS   B none   C no   D MISS
install  D:\DSH NEXT\resources\app.asar
         asar top level: node_modules assets build cordis.patch.yml
                         desktop-runtime.json host.cordis.patch.yml lib package.json scripts
         hardcoded path dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js → does not exist
         real candidates lib/desktop-cli.js · lib/main.js
         @deepseek-ai packages: 340, and dsh-desktop-host is not one of them

verdict DEFECT
```

### Re-measured 2026-11-14 (mneme `0.15.1`) → `FIXED`

Fixed in upstream #618, and the function was renamed `resolveCliJs`: a priority-ordered candidate array (`DSH_CLI_JS` → `<asar>/lib/desktop-cli.js` → the two legacy layouts), probed with `existsSync`, returning `{ path, candidates, verified: true }` on a hit. `DSH_CLI_JS` is treated as "the human already answered" — it is never second-guessed, and a missing one fails loudly on the path that was given. `locateDshExe` now tries both layouts (`DeepSeek Harness`, `DSH NEXT`) × both names and honours `DSH_EXE`.

```
source   A ok (resolveCliJs)   B none   C no   D ok (DSH_EXE override also known)
verdict FIXED
```

**This auditor misjudged it too.** It extracted the body of `locateCliJs` by that one name; after the rename there was nothing to extract, so a fixed version was graded `SUSPECT`. It now searches a list of names and prints which one it actually matched.

1. **It is worse than the issue says.** The report described three hardcoded prefixes (`app.asar.unpacked` / `app` / `node_modules`). Measured: DSH NEXT's asar has **no top-level `dsh/`**, and `dsh-desktop-host` **does not exist** among those 340 `@deepseek-ai` packages. Adding more prefixes cannot fix a package that is not there.
2. **The real entry sits right next door.** `app.asar/lib/desktop-cli.js` has been there all along; the invocation (`--expose-internals <path> --profile … --json headless <task>`) is unchanged — only that first argument needs to point at it.
3. **`locateDshExe` is equally single-minded.** DSH NEXT's binary is `DSH NEXT.exe` under `D:\DSH NEXT\`, while the fallback probes `Program Files\DeepSeek Harness\DeepSeek Harness.exe`. So even with the CLI path fixed, the exe layer still needs `DSH_EXE` — which is why "set DSH_EXE" in the issue is a requirement, not a convenience.

## Smallest fix (all three roles)

- **`locateCliJs`**: stop building one string; keep a candidate set (`lib/desktop-cli.js`, `dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`) and probe it from the **parent** process, where fs can see inside the asar. If nothing matches, `return null` so the caller takes the `kind: "environment"` branch with a readable reason — today it hands out a wrong path, turning a diagnosable error into "no output".
- **`locateDshExe`**: make the exe name a candidate list (`DSH NEXT.exe` / `DeepSeek Harness.exe`) and report which locations were tried on failure.
- **Caller (chorography orchestration)**: propagate `reason` into the report. `stubReportIfMissing(code)` currently overwrites the real cause — the other half of "no output".

## Self-check

`--selftest` feeds two synthetic sources (hardcoded defect / candidate probe) plus a `locateDshExe` shape, then walks a synthetic asar index through `asarHas` / `asarList`; if a real asar is present it also parses it as corroboration only. Currently **7/7**.

Across the four auditors in this repository, every judge bug so far was found by its first self-check run — it is the only thing that saves you when a wrong answer looks exactly like the right one.
