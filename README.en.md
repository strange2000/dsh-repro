# dsh-repro

> [中文](README.md) · English

Field notes and reproduction material from issues I filed against the DSH plugin ecosystem. Every issue I reported gets a stable number: the original report, a script that re-establishes the evidence, and the exact data provenance.

The point is one sentence: **"I measured it" should be replaceable by "you can re-run it here."**

## What gets listed

- **In the index** — the issue pins down a specific code location, or a specific observable criterion. Pure feature requests and "it felt wrong" reports don't make it.
- **Under `repro/`** — the defect can be decided by one command, and that verdict is useful to someone else (i.e. "is my copy still affected?").
- **Not accepted** — projects outside the DSH ecosystem; unreproducible intermittent behaviour (listed only, not dug into).
- The **status** column is the *upstream* issue state, not my progress.

## Index

Grouped by upstream project. Numbers are stable; links survive any reshuffling.

### slow-stack/mneme

| No. | Upstream | Root cause in one line | Evidence / material | Status |
|---|---|---|---|---|
| 0001 | [#493](https://github.com/slow-stack/mneme/issues/493) | Transcripts fed back as bare `user` messages, so the model thinks it is its turn; after a parse failure the same window is retried deterministically | [`repro/mneme-0001/`](repro/mneme-0001/README.en.md) — forensic script + three-arm control | closed |
| 0004 | [#534](https://github.com/slow-stack/mneme/issues/534) | Two ledgers disagree: at the run layer 17 of 19 consolidation rounds failed validation and the remaining 2 reported `ok` with `applied=0` (200 decisions, all `keep`), while the LLM audit layer recorded 18 successes — so an audit-based success rate reads ~95%, the opposite of reality. Failed rounds store no raw decisions | — (listed only) | closed |
| 0005 | [#553](https://github.com/slow-stack/mneme/issues/553) | `MemoryDrawer` never declares the `provenance` state (`lib/client.js:6484`) but calls `setProvenance(null)` at `:6522` → opening a memory detail throws `ReferenceError: provenance is not defined`, the renderer dies and DSH restarts. 100% reproducible | — (listed only) | closed |
| 0006 | [#557](https://github.com/slow-stack/mneme/issues/557) | `dream_runs` is the only table with no DELETE path at all (`lib/store.js` cleans `recall_runs` and `llm_audit_logs` only) and none of the four `*RetentionDays` keys cover it. Measured at ~43% of database pages, `input` averaging 79 KB/round, with row size × round count growing *superlinearly* — and it multiplies the cost of every hot snapshot | [retention auditor](repro/mneme-retention/README.en.md) ｜ [report 0005](reports/0005-mneme-silent-failures.md) | open |
| 0007 | [#578](https://github.com/slow-stack/mneme/issues/578) | `locateCliJs()` (`lib/wiki/t1.js:110`) hardcodes `resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`; the DSH NEXT asar has no `dsh/` level and the real headless entry is `app.asar/lib/desktop-cli.js` → T1 always fails, reporting only "headless exit code 1: (no output)" because the subprocess never started | [T1 entry auditor](repro/mneme-chorography/README.en.md) ｜ [report 0005](reports/0005-mneme-silent-failures.md) | open |
| 0008 | [#579](https://github.com/slow-stack/mneme/issues/579) | The error branches of `choro_module_map` / `choro_read_page` / `choro_search` `return { error, hint }` while all three declare a strict `additionalProperties: false` schema → the host rejects the payload as `invalid output` and the real reason (unregistered / ambiguous / missing page) is invisible | — (listed only) | closed |
| 0009 | [#581](https://github.com/slow-stack/mneme/issues/581) | Repository identity is keyed on a local absolute path (`lib/wiki/t0.js:47` stores `realpathSync(resolve(repoRoot))`; `t1.js:239` requires a character-exact match) → chorography cannot be shared across a dual-boot setup on one `memory.db`, and re-running T0 on the other side adds a second record, after which a call without `repo` is `repo-ambiguous` (whose payload then trips 0008) | — (listed only) | open |
| 0010 | [#582](https://github.com/slow-stack/mneme/issues/582) | The hand-rolled mini renderer in `dsh-mneme-wiki` turns `\|`-prefixed lines into monospace `div`s (`lib/client.js:10227` plus `.mneme-wikitablerow { white-space: pre }`), never strips `<!-- CHORO:T1:START -->`-style HTML comments, and never writes the front-matter `status` back after T1 (the database says `enriched`, the page still says `skeleton`) → a module page shows raw Markdown instead of the rendered page | — (listed only) | open |

### c1overzz/dsh-bili-scroll

| No. | Upstream | Root cause in one line | Evidence / material | Status |
|---|---|---|---|---|
| 0003 | [#47](https://github.com/c1overzz/dsh-bili-scroll/issues/47) | `pythonPath` forced back to `"python"` by the host's startup snapshot (Microsoft Store stub, exit 9009) / `saveCfg` rewrites the whole object / the desktop CLI exists only inside `app.asar` and the headless overlay disables three services | [`repro/bili-0003/`](repro/bili-0003/README.en.md) — read-only audit, 6 checks | open |
| 0011 | [#78](https://github.com/c1overzz/dsh-bili-scroll/issues/78) | `parseSeenTable()` accepts table rows only, while the rules never mandate a `seen.md` format → not one of the hundred-plus records can be read, so the panel's "videos it has scrolled" list is always empty | [auditor B5](repro/bili-0003/README.en.md) | closed |
| 0012 | [#79](https://github.com/c1overzz/dsh-bili-scroll/issues/79) | `POST /api/bili-duty/config` rebuilds the patch from a 1.x whitelist, so 2.0 keys (`dmWatch` / `favFolderId` / `personaPrompt`) are silently filtered → the panel's 5-second poll flips the toggle back; each save also drags along `{"keywords":[]}`, wiping the user's keywords. Counter-evidence: the MCP `bili_config` tool bypasses the whitelist, so on one machine the tool writes and the panel cannot | [auditor B6](repro/bili-0003/README.en.md) | closed |
| 0013 | [#80](https://github.com/c1overzz/dsh-bili-scroll/issues/80) | With `reportLevel=off` ("no daily report"), `countPickedToday()` counts report files only → always 0 → the `perDay` gate never fires; the single fallback constrains scheduled windows only, so `runDuty('manual')` ignores it → 10 picks in a day against a limit of 5, while `pickedToday` still shows 0 | [auditor B7](repro/bili-0003/README.en.md) | closed |
| 0014 | [#82](https://github.com/c1overzz/dsh-bili-scroll/issues/82) | Suggestion: the duty-round subprocess pins `cwd` to the plugin home (`const cwd = stateDir`), so every session it spawns lands in "ungrouped"; `WorkspaceRegistry.candidateMatches()` requires `realpath(header.cwd) === workspace path`, and patching `workspace.json` afterwards is filtered out on the next start — only a correct `cwd` works (author's own workaround: a `sessionWorkspace` key, passing `danger-full-access` at spawn, plus a sweep 8 s after startup) | — (listed only) | open |

### Ebony-Vinyl/dsh-our-free-model

| No. | Upstream | Root cause in one line | Evidence / material | Status |
|---|---|---|---|---|
| 0002 | [#427](https://github.com/Ebony-Vinyl/dsh-our-free-model/issues/427) | The host exposes no enumerable ESM cache, so `purgeCaches` clears 0 modules; the fallback `import()` tries a cache-busting query that the loader normalises away, so the already-evaluated old module comes back; the version assertion throws, and the updater reads "hot activation failed" as "upgrade failed" and calls `restoreBackup()` | [`repro/ofm-0002/`](repro/ofm-0002/README.en.md) — read-only audit (A/C are the deciding checks) | closed |

### zhu1090093659/dsh-web

| No. | Upstream | Root cause in one line | Evidence / material | Status |
|---|---|---|---|---|
| 0015 | [#1968](https://github.com/zhu1090093659/dsh-web/issues/1968) / [#1969](https://github.com/zhu1090093659/dsh-web/issues/1969) | The dsh-market.com edge relay intermittently answers 503 `relay storage unavailable` while `relay.state` still reports `running`; a phone boot pulls 111 front-end modules and one failure stops the bootloader from switching pages → stuck on `Loading plugins…` forever. The criterion is a same-path concurrency control: 6 concurrent 111/111 pass, then serial 22/111 fail (17 `relay storage unavailable`, 5 empty), while a throwaway `*.trycloudflare.com` tunnel passes 111/111 | — (listed only) | closed |
| 0016 | [#1954](https://github.com/zhu1090093659/dsh-web/issues/1954) / [#1955](https://github.com/zhu1090093659/dsh-web/issues/1955) | `packages/dsh-session-archive` claims the shared `settings.section` cell id `archived-sessions` (priority 0) and swallows the collision in `try/catch` → a third-party archive plugin loses its entire settings page with **zero** notice, leaving only a startup `Uncaught Error`. An id can have one registrant per list slot; whoever registers first owns it | [reports/0004](reports/0004-settings-section-shared-id.md) · [scanner](repro/settings-sections/README.en.md) (the other side of 0017) | closed |

### MichengAI/dsh-archive-manager

| No. | Upstream | Root cause in one line | Evidence / material | Status |
|---|---|---|---|---|
| 0017 | [#91](https://github.com/MichengAI/dsh-archive-manager/issues/91) | The other side of the same collision: the plugin registers `settings.section` with no conflict guard, hits the same id at the same priority, throws `Uncaught Error`, and **aborts its own client initialisation** (so its own settings page is broken too). Together the pair shows shared ids need defence on both sides | [reports/0004](reports/0004-settings-section-shared-id.md) · [scanner](repro/settings-sections/README.en.md) (the other side of 0016) | closed |

### GDWhisper/dsh-ntr

| No. | Upstream | Root cause in one line | Evidence / material | Status |
|---|---|---|---|---|
| 0018 | [#2](https://github.com/GDWhisper/dsh-ntr/issues/2) | In NTR mode an approval-requiring tool call is never turned into a host approval UI → no card, no hint, no placeholder; the UI just spins and the session hangs forever (only a 30-second memory heartbeat remains), so the process has to be killed. Criterion: the agent log shows `[tool-permission] ASK tool=Bash mode=default` followed by nothing | — (listed only) | closed |
| 0019 | [#3](https://github.com/GDWhisper/dsh-ntr/issues/3) | Three calls (`session/new` ×2 and `session/load`, `lib/bridge.js` L531 / L588 / L736) hardcode `mcpServers: []`, and the `agents.json` schema (`validateAgentDef`) has no mcp field at all → a peer agent advertising `mcpCapabilities: { http: true, sse: true }` still gets zero MCP tools. The pipe exists, it was simply never connected | — (listed only) | closed |

### anywhere-labs/dsh-desktop

| No. | Upstream | Root cause in one line | Evidence / material | Status |
|---|---|---|---|---|
| 0020 | [#1532](https://github.com/anywhere-labs/dsh-desktop/issues/1532) | Desktop injects `pnpm_config_minimum_release_age=0`, so the marketplace's own minimum-release-age check returns `unknown` and fails closed → every pending update shows "new version pending" forever and the Update button never appears. Criterion: `dsh-web-all` 0.4.8 vs npm 0.4.11, published 38 hours earlier, still locked. No crash, no error — very hard to self-diagnose | — (listed only) | closed |
| 0021 | [#1574](https://github.com/anywhere-labs/dsh-desktop/issues/1574) | The Host process exits while idle and the UI lands in recovery mode ("plugin service process exited, code 1"), 13 times in 5 days; the stack points at `fatal load failure` / `MeshCallError: Call deadline exceeded` on the fail-loud path (a late `unhandledRejection`). **Listed only, not dug into**: it is intermittent across days, there is no single decidable criterion, and fail-loud is #1158's intended design — it needs the upstream to separate "late timeout of an already-finished request" from "genuinely fatal" | — (listed only) | closed |

## Two notes

- **The material for 0002 / 0003 are read-only auditors, not one-shot reproduction scripts.** Both defects damage the user's own installation (an upgrade that rolls itself back; a config that overwrites itself), so running them on someone else's machine is not appropriate. The auditor answers the same question — "would *my* copy still do this?" — and every auditor ships `--selftest`, feeding the defective and the fixed shape of the same code through one decision function to prove it can tell them apart.
- All three of those defects are **fixed in current versions** (0002 as of 2.8.x, 0003 as of 2.5.0, measured on this machine). They stay here for the case that matters: when a version gets rolled back, or the marketplace ships an old build, one command tells you whether the defect is back.

## Three rules for reports

1. **Read-only forensics first.** Database queries, logs, exact line numbers — never guesswork.
2. **Separate "my environment" from "a product defect."** Use a control experiment that changes one variable and nothing else, instead of pasting a stack trace.
3. **Give the smallest fix.** If you can point at the line to change, don't write an essay.

## Environment

- Windows 11 + **DSH NEXT desktop 2.0.19-next** (bundled `@deepseek-ai/dsh` 0.2.1-rc.2, Electron + asar); the earliest report (0001) was measured on DSH Desktop 2.0.17.
- Plugins under test: `@modusensus/dsh-mneme` 0.9.3, `dsh-our-free-model` 2.5.x / 2.8.3, `dsh-bili-scroll` 0.1.7 / 2.5.0.
- Scripts run on the Node runtime bundled with DSH (v24, so `node:sqlite` can open a database read-only). **No `npm install` required.**
- Every forensic script opens databases with `readOnly: true` and reads source files read-only; nothing is written into the product under test.
- Every auditor supports `--selftest`: it first proves the decision function can tell the defective shape from the fixed one, then judges the real installation.
- No secrets are embedded: endpoint / key / model always come from environment variables.

## License

MIT (see [LICENSE](LICENSE)). The measurements are from my own machine; the scripts are free to reuse.
