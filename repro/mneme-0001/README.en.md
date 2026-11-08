# mneme-0001: summarisation fails (invalid summary JSON)

> [中文](README.md) · English

Upstream issue: [slow-stack/mneme#493](https://github.com/slow-stack/mneme/issues/493).
The full report is in [`../../reports/0001-mneme-summarize-invalid-json.md`](../../reports/0001-mneme-summarize-invalid-json.md).

There are two scripts here: **forensics first, reproduction second**. Neither writes to the product under test and neither contains credentials.

## 1. Forensics: are these failures sporadic, or a deterministic retry loop?

```bash
node scan-audit.cjs                       # defaults to E:/mneme/memory.db, last 7 days
node scan-audit.cjs --days 1 --op summarize_compress
```

It reads `llm_audit_logs` and `distill_cursors` only, and prints five sections:

1. **Outcome distribution per operation** — establish that the main path is healthy (measured at the time: `summarize_compress` 469 successes, 20 failures).
2. **Failure detail** — timestamp, model, `input_tokens`, duration, error string.
3. **The determinism test** — within failures sharing the same (op, model, error), does `input_tokens` grow monotonically? If it does, the *same window* is being retried, not 20 independent sporadic failures.
4. **`distill_cursors`** — is the cursor stuck at some `last_seq` that never advances?
5. **`metadata` retention** — the audit log does not store raw model output (measured: 100% NULL), so "what did the model actually say" can only come from the next step.

## 2. Reproduction: a three-arm controlled experiment

```bash
# Environment variables (do not write keys into files)
set MNEME_ENDPOINT=http://127.0.0.1:7863/v1
set MNEME_API_KEY=...
set MNEME_MODEL=cn:deepseek-v4.1-flash

node repro-prompt.mjs                 # built-in synthetic transcript
node repro-prompt.mjs --repeat 2      # run each arm twice to check stability
node repro-prompt.mjs --transcript my-dump.txt
```

The three arms differ in exactly one variable:

| Arm | system | user |
|---|---|---|
| A obedience | "Output this JSON and nothing else." | one unrelated sentence |
| B current | the distill prompt (format instructions live here) | **the raw transcript, pasted bare** |
| C hardened | same as B | transcript wrapped in `<<<TRANSCRIPT>>>` delimiters + a restated role: "you are a third-party extractor, not a participant in this conversation" |

How to read the result:

- **A succeeds** → the endpoint is not tampering with the system message, so the transport layer is fine.
- **B fails (not even a `[` in the output) while C succeeds** → the defect is in how the user message is built: the model reads the transcript as "something the user just said" and continues or comments on the conversation instead of summarising it.

To get your own transcript: if `distillRecords: true` is enabled, read `session_id + seq + role + text` straight out of `distill_records`. If not, rebuild an equivalent transcript using the `buildTranscript` conventions in `lib/summarize.js` (`User: …` / `Assistant: …` / `Tool call: …` / `Tool result (ok|error): …`).

## Measured result (Oct 2026, my machine)

| Arm | Result |
|---|---|
| A obedience | ✅ returns valid JSON |
| B current | ❌ 0/3 produced JSON (the model replied with Chinese commentary/corrections, `finish_reason=stop`, reasoning 700–3500 tokens) |
| C hardened | ✅ returns valid JSON reliably |

Same-batch audit data: all 20 `invalid summary JSON` failures fall inside one window, `input_tokens` climbs monotonically 8194 → 11118, and `distill_cursors.last_seq` is stuck at 2229.
