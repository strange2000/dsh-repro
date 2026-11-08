# Two defects that never throw: one grows quietly, the other swallows its own reason

> [中文](0005-mneme-silent-failures.md) · English
> Note: local absolute paths are abstracted to `<app>` in this translation.

<!-- tl;dr-en -->
> **TL;DR** Two mneme defects that never throw: (1) `dream_runs` has no `DELETE` path and no retention key applies to it — on this machine 92 rows hold 36.2% of the database pages (21.95 MB of 60.6 MB, `input` 12.21 MB, ~136 KB per row); 0.12.0 added an `input`-only trim, so the verdict is PARTIAL, not FIXED. (2) `locateCliJs()` hardcodes `resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`, but DSH NEXT's asar has no top-level `dsh/` and no `dsh-desktop-host` package at all among its 340 `@deepseek-ai` packages; the real entry is `app.asar/lib/desktop-cli.js`. The child therefore dies before it can print a stack, which is why the only symptom is `headless exit code 1: (no output)`. Both are judged by read-only auditors, and both verdicts were produced by scripts that self-check first.

They correspond to two upstream issues: [#557](https://github.com/slow-stack/mneme/issues/557) (`dream_runs` unbounded growth) and [#578](https://github.com/slow-stack/mneme/issues/578) (chorography T1 completely unusable on DSH NEXT). They look unrelated; they are written up together because of **one shared property**:

> Neither throws. One lets the database grow quietly, the other folds the failure reason into "no output". By the time you notice, the first task is always "prove it is actually happening" — and that is exactly the expensive step.

## Symptom

**#557** does not error; it only feels slower: backups take longer, snapshots grow, migrations time out. No log line points at `dream_runs`.

**#578** leaves one line:

```
headless exit code 1: (no output)
```

No stack, no stderr, no "module not found". The child process is handed **a path that does not exist**, so it exits before it can throw; and that stderr line is folded into the result object, where `stubReportIfMissing(code)` covers it with a placeholder paragraph.

Both scenes point at the same lesson: **"no error" does not mean "it did not happen"**, and "there is output" does not mean "the output is the reason".

## Criterion: what each auditor decides on

Read-only, zero dependencies, no plugin loaded, nothing written. Decisive items are deliberately split in two — **conclusion items** decide the verdict, **reference items** are only corroboration (looked at alone they misjudge fixed versions).

| Auditor | Conclusion items | Reference items |
|---|---|---|
| `repro/mneme-retention/` (#557) | A whether `dream_runs` has a `DELETE` path; B whether a retention key targets it; C whether an "`input`-only" trim exists (this is what makes the verdict PARTIAL) | D measured row count / share of pages / bytes / time span |
| `repro/mneme-chorography/` (#578) | A whether `locateCliJs` has candidates / probing; D whether `locateDshExe` recognises the DSH NEXT executable; whether the hardcoded path exists in a real install | B whether asar internals are readable; C whether a failed lookup does `return null` |

Both scripts ship `--selftest`: synthetic source shapes (defective / partially mitigated / fixed) are fed to the same judging function, **validate the ruler first, then read the verdict**. This is not ceremony — every judge bug in this repository's four auditors was caught by a first self-test run, and each of them looked exactly like the correct answer.

## Measured on this machine (2026-11-08, mneme `0.12.0`, DSH NEXT desktop)

**#557 — verdict `PARTIAL`**

```
database 60.6 MB · page 4096 × 15515 · freelist 0
dream_runs 92 rows → 21.95 MB → 36.2% of pages
input column 12.21 MB (92 rows populated, ~136 KB per row)
span 2026-10-14 → 2026-10-18, all run_type=auto

4 retention keys → 3 purge functions → target tables:
  recallRetentionDays            → purgeRecallRunsOlderThan → recall_runs
  reflectionFailureRetentionDays → deleteOldFailures       → failure_memories
  llmAudit.retentionDays         → deleteOldLlmAudits      → llm_audit_logs
  distillRecords.retentionDays   → clearDreamRunInputs     → dream_runs (**input column only**)
```

Three things must be said plainly:

1. **Very few rows, very large volume.** 92 rows eat 36.2% of the pages. Any cleanup policy that sets thresholds by row count will never fire on this table — that is why it was missed, and why the auditor reports **share of pages** rather than row count.
2. **The issue said 43%; it is 36.2% now.** Same lesion, growing a bit slower. A ratio like this is not evidence of a fix.
3. **0.12.0 added partial mitigation, hence PARTIAL.** `clearDreamRunInputs(before)` only nulls `input` on older rows (`run_type != 'organize'`); the rows themselves, `decisions` and `outcome` are kept forever. **It treats the fattest column, not the table.**

One easily misread point: deleting rows does not return file pages — SQLite needs `VACUUM` to shrink the file. `freelist 0` here means there are no pages waiting to be reclaimed right now, so "cleaned but the file did not shrink" will be the expected behaviour, not a cleanup that failed.

**#578 — verdict `DEFECT`**

```
asar top level: node_modules assets build cordis.patch.yml
                desktop-runtime.json host.cordis.patch.yml lib package.json scripts
hardcoded path dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js → does not exist
real entry candidates lib/desktop-cli.js · lib/main.js
@deepseek-ai packages 340, dsh-desktop-host does not exist among them

locateDshExe: only recognises deepseek harness.exe + Program Files\DeepSeek Harness
actual on this machine: <app>\DSH NEXT.exe
```

**The measurement goes one level deeper than the issue.** The original report described the problem as "three hardcoded prefixes `app.asar.unpacked` / `app` / `node_modules`", which sounds like a wrong prefix that a few more guesses could hit. What was measured: DSH NEXT's asar has **no top-level `dsh/` directory**, and the `dsh-desktop-host` package **does not exist at all** among the 340 `@deepseek-ai` packages. So this is not "the path is wrong", it is **that package does not exist in DSH NEXT** — no number of extra prefixes will ever assemble it.

The real entry `app.asar/lib/desktop-cli.js` has been there all along, and the invocation shape (`--expose-internals <path> --profile … --json headless <task>`) does not need a single change.

This also confirms why the issue's "set `DSH_EXE`" is a **necessary** condition: `locateDshExe` only recognises `deepseek harness.exe`, while the DSH NEXT binary is called `DSH NEXT.exe`. Fix the CLI path and the exe still cannot be located — it still will not run.

## Minimal fix

**#557 (retention)**

- Give `dream_runs` a real delete path (or a `dreamRunsRetentionDays` key that targets it), not just an `input` trim. The rows do not grow, but `decisions` / `outcome` will become the bulk in time.
- If audit value must be kept: keep the "round skeleton" (id / time / run_type / counters) and drop the large TEXT, so row count and volume decouple.
- Any cleanup must document `VACUUM`, otherwise "cleaned but the file did not shrink" reads as "the cleanup did nothing".

**#578 (T1 entry point)**

- Turn `locateCliJs` into candidate probing: at least the `lib/desktop-cli.js` and `dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js` layouts, **probed in the parent process** (Electron's fs can see paths inside asar; a plain node child cannot). If nothing matches, `return null` and degrade with `kind: "environment"`.
- Make `locateDshExe` try candidate executable names (`DSH NEXT.exe` / `DeepSeek Harness.exe`) and, on failure, **list the locations it tried**.
- The orchestration layer must pass `reason` through into the report instead of letting `stubReportIfMissing()` cover the real reason — that is the other half of "no output".

## Limits (stated before the conclusion)

- Both auditors are **static judgement + on-site numbers**; they do not run the real path: `#557` does not execute a cleanup and `#578` does not spawn the host. They answer "is the defect shape present", not "would it succeed if run" — the latter needs one real T1 run after the fix.
- The page-ratio for `#557` relies on `dbstat`. Without that vtab the script refuses to print a percentage rather than estimating a fake number from row counts.
- The asar parsing in `#578` reads **the directory index only**, it does not expand entry contents: it proves "the path does not exist", not "the real entry definitely runs".
- Both issues were filed on older versions than this machine (`#557` on 0.10.1, `#578` on 0.11.0). The `0.12.0` verdicts here cannot be projected backwards; they only say **whether the same shape is still there**.

## Relation to the three disciplines

- **Read-only forensics first**: both scripts are zero-dependency and read-only; ten runs give the same result as one and the environment under test is unchanged.
- **Separate "my environment" from "a product defect"**: `#578` is this round's example — one path holds in the "DeepSeek Harness" layout and fails in the "DSH NEXT" layout. Reporting "how the source is written" separately from "what the local install looks like" is exactly how environment differences avoid being mislabelled as product defects, and how real hardcoding avoids being waved through.
- **Give the smallest fix**: both are in the report, and neither asks for a rewrite — one adds a key / a delete path, the other adds candidate probing plus passing the reason through.
