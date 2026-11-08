# `settings.section` registration scanner

> [中文](README.md) · English

A **read-only** scanner for DSH plugin `settings.section` registrations. It answers one question: *on this machine, do two packages claim the same section id?* — the failure mode behind [0016 / 0017](../..) where a settings page silently disappears.

Zero dependencies, files only: it never loads a plugin, never talks to the host, never writes anything.

```bash
node scan-sections.cjs                  # scan every profile under ~/.dsh/profiles, then judge
node scan-sections.cjs --root <dir>     # a profile dir, or a node_modules dir
node scan-sections.cjs --json           # machine-readable, incl. verdict / hard / soft / selfDup
node scan-sections.cjs --all-slots      # every slot, not only settings.section
node scan-sections.cjs --selftest       # judge self-check on synthetic data only, machine untouched
```

Exit codes: `0` = scan completed (**a conflict does not change the exit code**), `1` = `--selftest` failed, `2` = bad argument or environment.

## How it reads a registration

Per the DSH plugin convention it resolves the client entry from `package.json` → `exports["./client"]`, then extracts `slots.register({ name, id, order })` from the bundle: the `name` literal anchors the match, `id` and `order` are taken from the following ~1200 characters (a literal, or an in-file `const` table). A registration is marked `swallowed` when `try {` precedes it and `} catch` follows it.

## The verdict

| Class | Meaning | Consequence |
|---|---|---|
| **hard** | same id **and** same order, from different packages (both orders missing counts too) | two settings pages compete for one slot; the later registrant is always affected |
| **soft** | same id, **different** order, different packages | different positions, one shared id — outcome depends on whether the host overrides or throws (0016 and 0017 are exactly those two outcomes) |
| **selfDup** | one package registers the same id more than once | usually the "mount-time + `slots.inject`" double path; if both fire, nobody checks the second one |

Verdict: `CONFLICT` (hard present) / `SUSPECT` (only soft) / `CLEAN` (no id collision).

**A `try/catch` around a registration is not a problem by itself — it is an amplifier.** The collision still happens; the losing side just fails silently, so what the user sees is "the settings page is gone". That is the root of 0016. The output therefore reports *how many swallowed registrations are involved in a collision*.

## Measured here (2026-11-08, profile `desktop`)

```
532 packages → 414 with a client entry → 413 files read → 16 packages register 16 settings.section
                                                                  (+5 settings.section.icon)

verdict CLEAN
hard           none
soft           none
selfDup        4  (archive-manager / bili-scroll / skills-manager, 2 sites each, icon slots included)
swallowed     10, none of them involved in a collision
```

1. `archived-sessions` is registered by nobody today — session-archive 0.4.16 moved to `dsh-session-archive`, archive-manager 1.2.8 to `archive-manager`. The collision shape is gone on this machine, both sides fixed.
2. **A shared `order` is not a conflict.** `archive-manager` / `dsh-email` / `dsh-notify-me` all use `order: 45` with distinct ids — they simply sit side by side. The id is the only criterion.
3. All 10 `try/catch` wrappers are defensive, not dangerous — but they are the reason a real collision would be silent.

## The bug `--selftest` caught

The first self-check run failed the "same package registers twice" case: it reported `selfDup=0`.

Cause: the two stages disagreed on what "one registration" means. Scanning **merges** multiple `register` sites of one package into one row with `sites=2`; the judge still looked for "more than one row per id", a branch that can never fire after merging. Fix: the judge accepts `sites > 1` as well.

Without that case the script would confidently print "same-package duplicates: none" while the truth was 4. **Trust the self-check before the verdict.**

## Limitations

Static scan of literals only: a dynamically injected registration shows only that the plugin *can* register, not that it did; conversely an overlay injection may be absent from the bundle. Registration merged across several sites shows as `×N`; a value that could not be resolved shows as `·`.

This tool is a ruler, not a judge: it tells you whether *this* machine has an id collision, not whether a given plugin is broken.
