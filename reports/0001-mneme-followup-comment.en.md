## Relationship to #424: this is the other half of "failed retries"

> [中文](0001-mneme-followup-comment.md) · English

<!-- tl;dr-en -->
> **TL;DR**
> - This is a follow-up comment on #424, not a duplicate: #424 covers *transient* failures (429 / 5xx / timeout) where a retry usually succeeds.
> - This report covers the opposite case: a **deterministic** failure where every retry reproduces the same result — `finish_reason` is `stop`, i.e. the model answered normally and the parse rejected the answer.
> - Retry yield is exactly 0 (20 failures out of 20 on the same window) while retry cost grows: input went 8194 → 11118 tokens, monotonically.
> - So once #424 lands, the window stuck at `last_seq=2229` will still be retried forever — in the current design "failed" only ever means "not finished yet".
> - Suggested guardrail below: an attempt cap plus an explicit give-up state, without changing normal semantics.

Item 4 of #424 is about **short retries after a failure** (12 of 102 rounds failed in the last 7 days, 11.8%; after moving to once-a-day, "one failure = a whole day lost"). This file describes the opposite case; the two complement each other rather than overlap:

| | Failure covered by #424 item 4 | Failure described here |
|---|---|---|
| Nature | Intermittent, self-healing (429/5xx/timeout) | **Deterministic**, a retry necessarily yields the same result |
| `finish_reason` | `error` / empty | **`stop`** (a normal return, not truncation / timeout / 429) |
| Retry yield | Very likely succeeds on the second attempt | **0**: 20/20 failures on the same window |
| Retry cost | One extra token spend | Input grows **monotonically** 8194 → 11118 tokens; the more it retries, the more it costs |

In other words: once #424 lands, only the "intermittent failure" case will retry more intelligently, while the window whose cursor is stuck at `last_seq=2229` will keep being retried — because under the current semantics a failure simply means "not distilled yet, come back next time". No path exists that admits "this content should be abandoned".

## Suggested minimal guardrail (without changing normal semantics)

1. **After N consecutive parse failures of the same kind → force-skip that window**: mark the span as skipped and advance the cursor (or split it in half and try each half once), so that "retry" has an upper bound. The point is to stop the `return` at `:869-877` from meaning "retry forever".
2. **Keep the raw output in the audit log**: today `llm_audit_logs.metadata` is always `null` and `distillRecognitionRecords` is off by default, so the only way to show that "the model output does not even contain a `[`" is external reproduction. Keeping 1–2 KB of the raw response (or the first and last 512 characters) would immediately tell whether "the model ignored the format" or "the format changed and the parser did not keep up".
3. If item 5 of #424 (a manual trigger entry point) lands first, at least the user gets a way to **unstick it by hand**; but deterministic failures still need automatic skipping — a manual entry point is a tourniquet, not a fix.

## Appendix: how to reproduce (no code changes needed)

POST the output of `buildTranscript` in `lib/summarize.js` straight to any OpenAI-compatible endpoint (system = `STR.prompts.summary`, user = the raw transcript) and it reproduces reliably:

- Minimal obedience (system only says "output JSON") → valid JSON returned, which shows the relay does not tamper with the system message;
- Current construction (transcript bare in user) → 0–2 successes, the model keeps writing Chinese commentary as if continuing the conversation;
- Explicit delimiters around the transcript + restating in the user message "you are a third-party distiller, not a conversation participant" → valid JSON returned reliably.

I can paste the reproduction script and the raw audit data (all fields of the 20 `invalid summary JSON` entries, plus a `distill_cursors` snapshot) directly into the thread — just say the word.
