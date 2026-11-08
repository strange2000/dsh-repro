# mneme-0001：总结提炼失败（invalid summary JSON）

> [English](README.en.md) · 中文

对应上游 issue：[slow-stack/mneme#493](https://github.com/slow-stack/mneme/issues/493)，
完整报告在 [`../../reports/0001-mneme-summarize-invalid-json.md`](../../reports/0001-mneme-summarize-invalid-json.md)。

这里有两个脚本：**先取证，再复现**。都不写被测产品，都不内置密钥。

## 1. 取证：这些失败是「偶发」还是「确定性重试」

```bash
node scan-audit.cjs                       # 默认 E:/mneme/memory.db，最近 7 天
node scan-audit.cjs --days 1 --op summarize_compress
```

它只读 `llm_audit_logs` / `distill_cursors`，输出五段：

1. 各操作的成败分布 —— 先确认主路径是好的（当年实测：`summarize_compress` 成功 469 次、失败 20 次）；
2. 失败明细 —— 时间、模型、`input_tokens`、耗时、错误串；
3. **确定性判据** —— 同一 (op, model, error) 的失败串里，`input_tokens` 是否单调增长。若是，就是「同一个窗口被反复重试」，不是 20 个独立的偶发失败；
4. `distill_cursors` —— 游标是否卡在某个 `last_seq` 不再前进；
5. `metadata` 留存情况 —— 审计里不存模型原始输出（实测 100% 为 NULL），所以「模型到底吐了什么」只能靠下一步复现。

## 2. 复现：三臂对照实验

```bash
# 环境变量（不要把 key 写进文件）
set MNEME_ENDPOINT=http://127.0.0.1:7863/v1
set MNEME_API_KEY=...
set MNEME_MODEL=cn:deepseek-v4.1-flash

node repro-prompt.mjs                 # 内置合成转录
node repro-prompt.mjs --repeat 2      # 每个臂跑两次看稳定性
node repro-prompt.mjs --transcript my-dump.txt
```

三个臂只改一个变量：

| 臂 | system | user |
|---|---|---|
| A obedience | 「只输出这个 JSON，不要任何其他文字」 | 无关一句话 |
| B current | 蒸馏 prompt（格式指令在这里） | **转录原文裸放** |
| C hardened | 同 B | 转录加 `<<<TRANSCRIPT>>>` 分隔符 + 重申「你是第三方提炼员，不是对话参与者」 |

判读方式：

- **A 成功** → 端点没有篡改 system，问题不在传输层；
- **B 失败（输出里连 `[` 都没有）而 C 成功** → 缺陷在「转录裸放 user 消息」这一处构造：模型读到的是一段「用户刚说完的话」，于是接着对话往下说或点评，而不是提炼。

如何拿到自己的转录：`distill_records` 表里若开启了记录（`distillRecords: true`）可以直接取 `session_id + seq + role + text`；未开启时，按 `lib/summarize.js` 的 `buildTranscript` 口径（`用户：…` / `助手：…` / `工具调用：…` / `工具结果（成功|失败）：…`）拼一份等价转录即可。

## 实测结果（2026-10，本机）

| 臂 | 结果 |
|---|---|
| A obedience | ✅ 正常返回 JSON |
| B current | ❌ 0/3 出 JSON（模型输出中文点评/纠错，`finish_reason=stop`，reasoning 700–3500 tokens） |
| C hardened | ✅ 稳定返回 JSON |

同批审计数据：20 次 `invalid summary JSON` 全部落在同一窗口，`input_tokens` 8194 → 11118 单调递增，`distill_cursors.last_seq` 卡在 2229。
