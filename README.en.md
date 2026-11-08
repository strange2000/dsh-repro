# dsh-repro

> [中文](README.md) · English

Measured evidence and reproduction material I attach when filing issues against the DSH plugin ecosystem. Every issue I filed gets a number: the original report + scripts you can actually run + the exact data they were run against.

The point is one sentence: turn *"trust me, I measured it"* into *"you can re-run this yourself."*

## Index

| No. | Target project | Report | Reproduction material |
|---|---|---|---|
| 0001 | [slow-stack/mneme](https://github.com/slow-stack/mneme) | [`reports/0001-mneme-summarize-invalid-json.md`](reports/0001-mneme-summarize-invalid-json.md) (upstream issue #493) | [`repro/mneme-0001/`](repro/mneme-0001/README.en.md) forensic script + three-arm controlled experiment |
| 0002 | [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) | [`reports/0002-dsh-our-free-model.md`](reports/0002-dsh-our-free-model.md) | [`repro/ofm-0002/`](repro/ofm-0002/README.en.md) read-only audit: would an in-app upgrade still roll back? (fixed, measured on 2.8.x) |
| 0003 | [c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) | [`reports/0003-dsh-bili-scroll.md`](reports/0003-dsh-bili-scroll.md) | [`repro/bili-0003/`](repro/bili-0003/README.en.md) read-only audit: are the three "installed but unusable" bugs still there? (fixed, measured on 2.5.0) |

Two notes:

- **The 0002 / 0003 material is a read-only auditor, not a one-click repro script.** Both defects damage the user's own installation (an upgrade that rolls back, a config that gets overwritten), so running them against someone else's machine would be irresponsible. The auditor answers the same question — *"will my copy still do this?"* — and ships with `--selftest`, which feeds synthetic defect-version and fixed-version sources to the same decision function and requires it to tell them apart.
- **All three issues are currently fixed** (0002 on 2.8.x, 0003 on 2.5.0, measured on my machine). Their value now is this: if a version ever regresses or a marketplace release ships an old package, one command tells you whether the defect is back.

## Three rules for these reports

1. **Read-only forensics first**: database queries, logs, source line numbers — no guessing.
2. **Separate "my environment" from "a product defect"**: use a controlled experiment (change one variable, hold everything else) instead of pasting a stack trace.
3. **Offer the smallest possible fix**: naming the line that should change beats a long essay.

## Environment

- Windows 11 + **DSH NEXT desktop 2.0.19-next** (bundles `@deepseek-ai/dsh` 0.2.1-rc.2, Electron + asar); the early 0001 work was measured on DSH Desktop 2.0.17.
- Plugins under test: `@modusensus/dsh-mneme` 0.9.3, `dsh-our-free-model` 2.5.x / 2.8.3, `dsh-bili-scroll` 0.1.7 / 2.5.0.
- Scripts run on the Node runtime shipped with DSH (v24, `node:sqlite` can open a database read-only), so **no `npm install` is required**.
- Every forensic script opens databases with `readOnly: true` and reads sources read-only; nothing writes to the product under test.
- Audit scripts all support `--selftest`: the decision function is validated against synthetic defect and fixed sources before it is pointed at a real install.
- No credentials are baked in: endpoint / key / model come from environment variables.

## License

MIT (see [LICENSE](LICENSE)). The measurements come from my own machine; the scripts are free to reuse.
