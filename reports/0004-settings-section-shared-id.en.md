# A shared `settings.section` id: one collision, both sides must defend

> [中文](0004-settings-section-shared-id.md) · English

<!-- tl;dr-en -->
> **TL;DR**
> - Two DSH plugins collided on the same `settings.section` id (`archived-sessions`): the claimer registered first and swallowed the collision in `try/catch`, the loser threw `Uncaught Error` and aborted its own client init.
> - The user-visible symptom is not an error — it is a settings page that silently is not there.
> - The real defect is the shared-id contract, not either plugin: an id can have one registrant per list slot, so **the claimer must degrade loudly and the registrant must tolerate being occupied**.
> - `repro/settings-sections/scan-sections.cjs` is the ruler: it reads client bundles only, lists every `settings.section` registration (id / order / swallowed), and judges `CONFLICT` / `SUSPECT` / `CLEAN`.
> - Measured on this machine 2026-11-08: 16 sections from 16 packages, **0 id collisions** — both plugins have since moved to their own namespace, so the defect shape is gone but the contract is still unenforced.

---

## Symptom

From the user's side there is exactly one sentence: **a plugin's settings page is gone**.

No error dialog, no half-broken feature — the whole section simply does not exist. The startup console leaves a single `Uncaught Error` and nothing afterwards. The usual conclusion is "the plugin is broken" or "this version dropped the feature", never "two plugins fought over the same id".

Two different failure shapes sit on this path (upstream [#1954](https://github.com/zhu1090093659/dsh-web/issues/1954) / [#1955](https://github.com/zhu1090093659/dsh-web/issues/1955) and [MichengAI/dsh-archive-manager#91](https://github.com/MichengAI/dsh-archive-manager/issues/91)):

| Side | What it does | What happens |
|---|---|---|
| The claimer | Registers the shared id `archived-sessions` (priority 0), wrapped in `try/catch` | Takes the slot; the displaced side gets **zero notification** |
| The displaced side | No conflict protection at all when registering | A same-id same-priority collision throws `Uncaught Error` **and aborts its own client init** — even its own settings page cannot open |

The key point: **both sides are "correct by their own logic"**. The claimer thinks it is being tolerant (one failure should not take down the whole panel); the displaced side thinks it did nothing wrong (why is this my problem). The root of the collision is not either side's coding style — it is that sharing an id has no contract.

## Criterion: decided by a static scan, not by guessing

What is invisible in the panel is visible in the code. `repro/settings-sections/scan-sections.cjs` reads client bundles only:

- locates the client entry via `exports["./client"]` in `package.json`, following the DSH plugin convention;
- extracts the literals of `slots.register({ name, id, order })` from the bundle;
- decides whether that registration sits inside a `try/catch` (`swallowed`);
- judges the scan: **same id, same order → hard conflict**, **same id, different order → soft conflict**, **multiple registrations in one package → self duplicate**, with three verdicts `CONFLICT` / `SUSPECT` / `CLEAN`.

```bash
node repro/settings-sections/scan-sections.cjs            # scan every profile under ~/.dsh/profiles
node repro/settings-sections/scan-sections.cjs --json     # machine-readable (verdict / hard / soft / selfDup)
node repro/settings-sections/scan-sections.cjs --selftest # validate the judge itself first (7 synthetic cases)
```

The judge ships a `--selftest` because it can be wrong too — and it was, on the first run: the scan phase merged multiple `register` calls of one package into a single row (recording `sites`), while the judge phase looked for multiple *rows* to detect a self duplicate, so that branch never fired and the script kept printing "self duplicates: none" (the truth was 4). **Trust the self-check before you trust the conclusion.**

## Measured on this machine (2026-11-08, profile `desktop`)

```
532 packages → 414 with a client entry → 413 files read → 16 packages registering 16 settings.sections (plus 5 settings.section.icon)

verdict CLEAN
hard conflicts   none
soft conflicts   none
self duplicates  4 (archive-manager / bili-scroll / skills-manager, 2 each, counting icon slots)
swallowed registrations 10, of which 0 involved a conflict
```

Three facts worth keeping:

1. **Nobody registers the id `archived-sessions` any more.** `@linxin666/dsh-session-archive@0.4.16` now uses its own namespace `dsh-session-archive`, and `@michengai/dsh-archive-manager@1.2.8` uses `archive-manager`. The collision shape from those two issues is gone on this machine — the fix worked, and both sides changed.
2. **A shared `order` is not a conflict.** `archive-manager` / `dsh-email` / `dsh-notify-me` all use `order: 45` with different ids; they simply sit side by side. The criterion is always the **id**.
3. **10 registrations are wrapped in `try/catch`, 0 of them involved a conflict.** Those are each plugin's own defensive habit and harmless right now — but the price is that **when a real collision happens the user is never told**. That mute switch is exactly what bug 0016 is about.

## Two-way minimal fix

**The claimer (whoever wants to register)**

1. Prefer your own namespace: `<pkg>-<section>`, not a descriptive generic word like `archived-sessions`. Descriptive ids are public resources by nature.
2. When sharing is unavoidable, check first and then register, and on failure **say it in plain words**: registration rejected → fall back to an independent id and `warn('[pkg] settings.section "x" is already taken, falling back to "pkg-x"')` instead of a silent `try { … } catch {}`.
3. If you really do intend to displace someone, say so explicitly (log the displaced id and its owner) so that whoever debugs this later can see the causal chain at a glance.

**The displaced side (whoever must not be displaced)**

1. Check whether the id is taken before registering; when it is, do not throw outside your own init — yield with an independent id, or mount the section under your own sub-entry.
2. An `Uncaught Error` must not abort the whole client init: one failed section registration should not take the rest of the plugin down with it.

**Host / framework layer (the real place to fix it)**

- A second registration of the same id should be **observable**: warn explicitly or throw explicitly, and print both the owner and the id. In the current shape one `try/catch` makes it all disappear, which is the same as delegating the contract to plugin etiquette.
- Public extension points (slot injection / registration APIs) should encourage namespaced ids, which removes a whole class of "descriptive id collision" events.

## Limits (stated before the conclusion)

The static scan reads **literals**: for dynamic registration (on-demand `register`, ids assembled across files) it can only see "it is able to register", not that it registered right now; conversely, registrations injected at runtime through an overlay may not be in the bundle at all. Rows marked `×N` are merged multiple `register` calls in one package; `·` marks a field that could not be read.

So the scanner is a **ruler**, not a judge: it tells you whether this machine has a same-id collision, not that a particular plugin is definitely broken.

## Relation to the three disciplines

- **Read-only forensics first**: no plugin loading, no host connection, no disk writes — only bundle literals are read.
- **Separate "my environment" from "a product defect"**: the disappearance of `archived-sessions` here is evidence that this machine is fixed, not evidence that upstream is still broken; and upstream fixing it does not mean every user upgraded — which is precisely why the scanner exists.
- **Give the smallest fix**: the three sections above can each land within an hour.
