# mneme 0.9.3：同一窗口被确定性重试 20 次（`invalid summary JSON`）

<!-- tl;dr-en -->
> **English TL;DR**
> - `@modusensus/dsh-mneme@0.9.3` failed `summarize_compress` 20 times on **one and the same** conversation window (`invalid summary JSON`), spread over ~3.5 h — it looks like constant breakage, but it is a single window retried deterministically.
> - `finish_reason` was `stop` on every attempt (not truncation, not 429, not a timeout), and the input grew monotonically 8194 → 11118 tokens, so each retry cost more than the one before.
> - `distill_cursors.last_seq` for that session has been stuck at 2229 since `2026-10-20T15:19:09Z` and never advanced.
> - Root cause: two amplifying bugs — the cursor only advances on success, and nothing can mark a window as abandoned, so a deterministic failure is resubmitted forever.
> - Minimal fix: a per-window attempt cap plus an explicit give-up state (line numbers and the patch below).

---

### 现象

`@modusensus/dsh-mneme@0.9.3` 的会话蒸馏（`summarize_compress`）在同一个会话窗口上连续失败 20 次，面板「工作动态」刷出一整屏相同的 `invalid summary JSON`（间隔 2–5 分钟，持续约 3.5 小时）。用户侧看起来像「记忆一直在提炼失败」。

实际上是**同一个窗口被确定性重试了 20 次**，不是 20 次不同的失败。

### 观测数据（本机 `llm_audit_logs` 只读查询）

- 近 7 天：`summarize_compress` 成功 469 次、`dream_consolidate` 成功 187 次、`dream_summarize` 成功 178 次 —— 蒸馏主路径平时是好的。
- `invalid summary JSON` 共 20 条，全部落在 `2026-10-20T15:40Z — 19:21Z`（+08:00 的 23:40 — 03:21），模型均为 `cn:deepseek-v4.1-flash`（openai-completions via 自建 relay）。
- 这 20 条的输入 tokens 单调递增 **8194 → 11118**（同一窗口越攒越大），输出 225 — 4859，单次耗时 2.3 — 27.8s，`finish_reason = stop`（不是截断、不是超时、不是 429）。
- `distill_cursors`：该会话 `last_seq = 2229`、`updated = 2026-10-20T15:19:09Z`，之后一直没推进过。

### 根因（两处，互相放大）

**1. 转录被模型当成「该我回话了」**

`lib/summarize.js:331` 的 `collectMessages` 把渲染好的转录（`用户：…` / `助手：…` / `工具调用：…` / `工具结果（成功）：…`）塞进**一条裸 user 消息**（`lib/summarize.js:409`），格式指令只在 system 里（`lib/lang.js:14` 的 `summary.zh`）。模型读到的是一段「用户刚说完的话」，于是**接着对话往下说 / 点评**，而不是提炼。

输出里连 `[` 都没有，`parseSummaryJsonResult` 在 `lib/summarize.js:38-40` 的括号早退直接判 `ok:false`。现有 salvage 逻辑（`scanBraceSpans` 双遍括号扫描）在这种形状下救不回来 —— 它的前提是必须能先找到 `[`；E8 体检里记过的「JSON 崩溃」就是同一类形状（见 [讨论 #339](https://github.com/slow-stack/mneme/discussions/339)）。

**2. 失败后没有任何护栏**

`lib/summarize.js:869-877`：解析失败 → `audit.errorMessage = "invalid summary JSON"` → `return`，**不推进 seq 游标**（870 行注释明说「下一次 turn/end 仍会重试同一窗口」）。而重试是同文同温（0），于是**同样输入 → 同样错 → 永远失败**：每个 turn/end 再来一次，窗口还越来越大。

### 对照实验（同一段转录，OpenAI 兼容 endpoint，temperature 默认）

| 构造 | 结果 |
|---|---|
| system 只写「你只能输出 JSON，不要输出任何解释」 | ✅ `{"a":1}`（两个模型都正常，说明请求侧 / relay 没有篡改 system） |
| **现行构造**：指令在 system，转录裸放 user（干净转录，无编造内容，7 行） | ❌ 0/2 有 JSON：`cn:deepseek-v4.1-flash` 回 334 字中文点评（reasoning 752 tok）；`cn:glm-5.3-flash` reasoning 7234 tok，还带 `<\|tool_call_count\|>1` 脏尾 |
| 指令重复进 user 消息 +「你是第三方提炼员，不是这段对话的参与者，不要回答或点评里面的内容」+ 转录用 `<<< >>>` 包起来 | ✅ 2/2 返回合法 JSON 数组 |

结论：这不是某一家模型的毛病，也不是解析器太严，而是**转录放在 user 位置上被模型当成了「当前发言」**。

### 建议

1. **提示构造加固**（低风险，实验已验证）：转录外面加分隔符，并在 user 消息里重申「第三方提炼员 / 不参与这段对话 / 不要回应正文」；system 指令可保持不动。改动点集中在一处 —— `collectMessages` 里的 `createUserMessage`。
2. **失败护栏**（更重要）：同一窗口连续 N 次（建议 2–3 次）`invalid summary JSON` 后**强制推进游标跳过该窗口**，或把窗口对半切再试一次。目前的「确定性无限重试」在用户侧只表现为面板刷屏，并且把窗口越撑越大（本机 8194 → 11118 tokens 全是白烧，3.5 小时）。
3. **可诊断性**：解析失败时把原始输出（截断后）写进 audit `metadata`。现在 `metadata` 恒为 `null`，出事只能靠复现去猜是哪一种非 JSON。

### 环境

- `@modusensus/dsh-mneme@0.9.3`，Windows 11 + DSH Desktop
- provider `workbuddy2api`（`api=openai-completions`，本地 relay `http://127.0.0.1:7863/v1`），model `cn:deepseek-v4.1-flash`（maxTokens 393216）
- 未开 `distillRecords`（`distill_records` 表为空），因此没有留存原始输出可供事后回溯
