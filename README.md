# dsh-repro

给 DSH 插件生态报 issue 时用的**实测与复现材料**。每个报过的 issue 对应一个编号：报告原文 + 可以直接跑的取证/复现脚本 + 原始数据口径。

目的只有一句话：把「我说我测到了」变成「你可以在这里自己重跑一遍」。

## 索引

| 编号 | 目标项目 | 报告 | 复现材料 |
|---|---|---|---|
| 0001 | [slow-stack/mneme](https://github.com/slow-stack/mneme) | [`reports/0001-mneme-summarize-invalid-json.md`](reports/0001-mneme-summarize-invalid-json.md)（上游 issue #493） | [`repro/mneme-0001/`](repro/mneme-0001/) |
| 0002 | [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) | [`reports/0002-dsh-our-free-model.md`](reports/0002-dsh-our-free-model.md) | — |
| 0003 | [c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) | [`reports/0003-dsh-bili-scroll.md`](reports/0003-dsh-bili-scroll.md) | — |

## 报告的三条纪律

1. **先只读取证**：数据库查询、日志、代码行号——不靠猜。
2. **区分「我的环境问题」和「产品缺陷」**：用对照实验（只改一个变量，其余不动），而不是只贴一段报错。
3. **给出最小修法**：能指出该改哪一行，就不写长篇建议。

## 环境

- Windows 11 + DSH Desktop；被测插件示例：`@modusensus/dsh-mneme` 0.9.3。
- 脚本用 DSH 自带的 Node 运行时（v24，`node:sqlite` 可直接只读查库），**不需要 `npm install`**。
- 所有取证脚本都以 `readOnly: true` 打开数据库，不会写入被测产品。
- 脚本不内置任何密钥：endpoint / key / model 全部走环境变量。

## 许可

MIT（见 [LICENSE](LICENSE)）。报告里的实测数据来自我自己的机器，脚本可自由复用。
