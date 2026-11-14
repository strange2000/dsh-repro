# mneme retention auditor · `dream_runs`


> Note: the data-side arithmetic in `--selftest` uses `node:sqlite`, which needs Node >= 22.5. On older Node that step prints `skip` and is skipped; the five source-side cases still run.
> 中文 · [English](README.en.md)

One command answers one question: **in your build of mneme, does anything make `dream_runs` get old and small?**

Upstream: [slow-stack/mneme#557](https://github.com/slow-stack/mneme/issues/557) — at 0.10.1 that audit table had no retention key, grew unbounded, and measured ~43% of the database pages, while all four `*RetentionDays` keys ignored it.

The failure mode is that **it never errors**: the file just grows, until backups, migrations and snapshots all get slow.

```bash
node audit-retention.cjs                        # find mneme in a profile, read ~/.dsh/memory/memory.db
node audit-retention.cjs --plugin <dir> --db <file>
node audit-retention.cjs --json
node audit-retention.cjs --selftest             # synthetic sources + in-memory db; verify the judge first
```

Zero dependencies, read-only: sources via `readFileSync`, the database opened with `readOnly`. Exit codes: `0` = audit ran (a defect does not change it), `1` = self-check failed, `2` = bad argument or environment.

## What it judges

| Item | Criterion | Weight |
|---|---|---|
| **A** `dream_runs` has a `DELETE` path | `DELETE FROM dream_runs`, or a `deleteOldDreamRuns` / `purgeDreamRuns` family | verdict |
| **B** a *row-delete* retention key applies to `dream_runs` | something like `dreamRunsRetentionDays` | verdict |
| **B2** a *column-trim* switch exists (opt-in, usually `0` = off) | something like `dreamRunsTrimDays` | verdict (decides `OPT-IN`) |
| **C** an `input`-only trim exists | `UPDATE dream_runs SET input = NULL` | verdict (decides `PARTIAL` / `OPT-IN`) |
| **D** measured rows / page share / `input` bytes / time span | `dbstat` + `LENGTH(input)` | evidence only, **not part of the verdict** |

It also prints the whole chain "retention key → purge function → target table", which is the only honest way to answer *why none of the four keys covers it*.

Verdicts: `FIXED` (delete path plus a key, or a purge function pointing at the table) · `OPT-IN` (no delete path, but a column-trim switch exists — **off by default, so nothing happens until you set it**) · `PARTIAL` (no delete path, no key, but `input` trim — only the fattest column is treated, rows stay forever) · `DEFECT` (none of the three) · `SUSPECT` (a key exists without a delete path, so the key may be dead).

## Measured here (2026-11-08, mneme `0.12.0`, profile `desktop`)

```
source     A MISS   B MISS   C ok
retention keys (4): recallRetentionDays / reflectionFailureRetentionDays /
                    llmAudit.retentionDays / distillRecords.retentionDays  (all default 90 days)
purge functions (3): purgeRecallRunsOlderThan → recall_runs
                     deleteOldLlmAudits     → llm_audit_logs
                     deleteOldFailures      → failure_memories
dream_runs coverage: none

data       db 60.6 MB · page 4096 × 15515 · freelist 0
           dream_runs 92 rows → 21.95 MB → 36.2% of pages
           input column 12.21 MB (92 rows, 136 KB/row average)
           span 2026-10-14 → 2026-10-18

verdict PARTIAL
```

### Re-measured 2026-11-14 (mneme `0.15.1`) → `OPT-IN`

Upstream resolved #557 as "**trimming columns: yes; deleting rows: no**". `src/config.js:1068` adds `dreamRunsTrimDays` (`z.natural().min(0).max(3650).default(0)`) which, at startup, nulls `input`/`decisions`/`outcome` for rounds older than the window. Rows and the skeleton columns are always kept; `organize` rows are exempt because `input` is the replay payload for apply. Path: `src/maintenance.js` → `store.dreamRunInputStats()` / `store.clearDreamRunInputs()`.

```
source   A MISS   B MISS   B2 ok (dreamRunsTrimDays, default 0 = off)   C ok
verdict OPT-IN
```

**This auditor got it wrong once.** The first version only looked for `*RetentionDays` and `DELETE`; a key called `dreamRunsTrimDays` matches neither, so it read as "no key at all" and graded an accepted upstream fix as `PARTIAL`. `B2` is now its own item, and the default is printed with it — `0 days = no trimming` is the easiest part of this fix to miss: leave it unset and nothing changes.

1. **Very few rows, very large table.** 92 rows take 36.2% of the pages because each row carries ~136 KB of `input`. A row-count threshold will never fire on a table shaped like this.
2. **The four retention keys really do not cover it** — three purge functions point at `recall_runs` / `llm_audit_logs` / `failure_memories`, and `distillRecords.retentionDays` trims `distill_records`. Exactly as filed in #557, only the version moved from 0.10.1 to 0.12.0.
3. **0.12.0 added a partial mitigation.** `clearDreamRunInputs(before)` sets `input = NULL` for rows older than the cutoff (`run_type != 'organize'`), reachable through the maintenance/reclaim entry behind `distillRecords.retentionDays`. It clears the fattest column, but **rows, `decisions` and `outcome` stay forever** — hence `PARTIAL`, not `FIXED`.

## Two caveats worth writing down

- **Deleting rows does not return pages.** Pages go to the freelist; the file only shrinks after `VACUUM`. So "cleaned but the file did not shrink" is expected, not a silent failure. This machine currently reports `freelist 0`.
- **`dbstat` is not guaranteed.** Without that vtab the page share is reported as empty; the script refuses to estimate a fake percentage from row counts.

## Self-check

`--selftest` feeds the same judge synthetic sources (defect / partial / fixed) and measures an in-memory database with three known rows. Currently 6/6.

This is not ceremony: of the three auditors in this repository plus the settings.section scanner, **every judge bug so far was caught by its first self-check run** — and each one looked exactly like a correct answer.
