# mneme 0.9.3: the same window retried 20 times, deterministically (`invalid summary JSON`)

> [中文](0001-mneme-summarize-invalid-json.md) · English

<!-- tl;dr-en -->
> **TL;DR**
> - `@modusensus/dsh-mneme@0.9.3` failed `summarize_compress` 20 times on **one and the same** conversation window (`invalid summary JSON`), spread over ~3.5 h — it looks like constant breakage, but it is a single window retried deterministically.
> - `finish_reason` was `stop` on every attempt (not truncation, not 429, not a timeout), and the input grew monotonically 8194 → 11118 tokens, so each retry cost more than the one before.
> - `distill_cursors.last_seq` for that session has been stuck at 2229 since `2026-10-20T15:19:09Z` and never advanced.
> - Root cause: two amplifying bugs — the cursor only advances on success, and nothing can mark a window as abandoned, so a deterministic failure is resubmitted forever.
> - Minimal fix: a per-window attempt cap plus an explicit give-up state (line numbers and the patch below).

---

### Symptom

Session distillation (`summarize_compress`) in `@modusensus/dsh-mneme@0.9.3` failed 20 times in a row on the same conversation window, and the panel's activity feed filled up with identical `invalid summary JSON` entries (2–5 minutes apart, lasting ~3.5 hours). From the user's side it looks like "memory distillation keeps failing".

It is actually **one window retried deterministically 20 times**, not 20 different failures.

### Observed data (read-only query against the local `llm_audit_logs`)

- Last 7 days: `summarize_compress` succeeded 469 times, `dream_consolidate` 187, `dream_summarize` 178 — the main distillation path is healthy most of the time.
- `invalid summary JSON` appears 20 times, all inside `2026-10-20T15:40Z — 19:21Z` (+08:00 23:40 — 03:21), all on model `cn:deepseek-v4.1-flash` (openai-completions via a self-hosted relay).
- Across those 20 entries the input tokens increase monotonically **8194 → 11118** (the same window keeps growing), output 225 — 4859, latency 2.3 — 27.8 s, `finish_reason = stop` (not truncation, not a timeout, not 429).
- `distill_cursors`: that session sits at `last_seq = 2229`, `updated = 2026-10-20T15:19:09Z`, and never advanced afterwards.

### Root cause (two bugs, amplifying each other)

**1. The transcript is read by the model as "now it's my turn"**

`collectMessages` at `lib/summarize.js:331` puts the rendered transcript (`用户：…` / `助手：…` / `工具调用：…` / `工具结果（成功）：…`) into **one bare user message** (`lib/summarize.js:409`), while the format instruction lives only in the system prompt (`summary.zh` in `lib/lang.js:14`). The model reads a block that looks like "the user just finished speaking", so it **continues the conversation / comments on it** instead of distilling.

The output does not even contain a `[`, and the early-exit bracket check in `parseSummaryJsonResult` (`lib/summarize.js:38-40`) returns `ok:false` immediately. The existing salvage logic (`scanBraceSpans`, a two-pass brace scan) cannot rescue this shape — it needs to find a `[` first. The "JSON breakage" recorded in the E8 health check is the same class of shape (see [discussion #339](https://github.com/slow-stack/mneme/discussions/339)).

**2. No guardrail after a failure**

`lib/summarize.js:869-877`: parse failure → `audit.errorMessage = "invalid summary JSON"` → `return`, **without advancing the seq cursor** (the comment on line 870 says it outright: "the next turn/end will retry the same window"). Retries run at the same temperature (0) on the same text, so **same input → same error → fails forever**: once more on every turn/end, with the window growing each time.

### Controlled experiment (same transcript, OpenAI-compatible endpoint, default temperature)

| Construction | Result |
|---|---|
| System prompt only says "output JSON only, no explanation" | ✅ `{"a":1}` (both models behave, so neither the request side nor the relay tampers with the system message) |
| **Current construction**: instruction in system, transcript bare in user (clean transcript, no fabricated content, 7 lines) | ❌ 0/2 produced JSON: `cn:deepseek-v4.1-flash` returned a 334-character Chinese commentary (752 reasoning tokens); `cn:glm-5.3-flash` burned 7234 reasoning tokens and ended with a dirty `<\|tool_call_count\|>1` tail |
| Instruction repeated in the user message + "you are a third-party distiller, not a participant in this conversation, do not answer or comment on the content" + transcript wrapped in `<<< >>>` | ✅ 2/2 returned a valid JSON array |

Conclusion: this is not one vendor's model misbehaving, and not an over-strict parser — it is the transcript sitting in the user position being read as "the current utterance".

### Recommendations

1. **Harden the prompt construction** (low risk, verified by the experiment): wrap the transcript in delimiters and restate "third-party distiller / not a participant / do not respond to the content" in the user message; the system instruction can stay as is. The change is localised to one place — `createUserMessage` in `collectMessages`.
2. **Failure guardrail** (more important): after N consecutive `invalid summary JSON` failures on the same window (2–3 suggested), **force the cursor forward and skip that window**, or split the window in half and try each half once. Today's "deterministic infinite retry" shows up to the user only as a scrolling panel, and it keeps inflating the window (8194 → 11118 tokens here, all wasted, for 3.5 hours).
3. **Diagnosability**: on parse failure write the raw output (truncated) into the audit `metadata`. `metadata` is always `null` today, so after the fact the only way to tell which kind of non-JSON it was, is to reproduce it.

### Environment

- `@modusensus/dsh-mneme@0.9.3`, Windows 11 + DSH Desktop
- provider `workbuddy2api` (`api=openai-completions`, local relay `http://127.0.0.1:7863/v1`), model `cn:deepseek-v4.1-flash` (maxTokens 393216)
- `distillRecords` disabled (the `distill_records` table is empty), so no raw output was retained for later inspection
