# dsh-repro

> [English](README.en.md) · 中文

给 DSH 插件生态报 issue 时用的**实测与复现材料**。每个报过的 issue 对应一个编号：报告原文 + 可以直接跑的取证/复现脚本 + 原始数据口径。

目的只有一句话：把「我说我测到了」变成「你可以在这里自己重跑一遍」。

## 索引

| 编号 | 目标项目 | 报告 | 复现材料 |
|---|---|---|---|
| 0001 | [slow-stack/mneme](https://github.com/slow-stack/mneme) | [`reports/0001-mneme-summarize-invalid-json.md`](reports/0001-mneme-summarize-invalid-json.md)（上游 issue #493） | [`repro/mneme-0001/`](repro/mneme-0001/) 取证脚本 + 三臂对照实验 |
| 0002 | [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) | [`reports/0002-dsh-our-free-model.md`](reports/0002-dsh-our-free-model.md) | [`repro/ofm-0002/`](repro/ofm-0002/) 只读审计：升级还会不会回滚（已修，2.8.x 实测） |
| 0003 | [c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) | [`reports/0003-dsh-bili-scroll.md`](reports/0003-dsh-bili-scroll.md) | [`repro/bili-0003/`](repro/bili-0003/) 只读审计：三处装完不能用的 bug 还在不在（已修，2.5.0 实测） |

两处补记：

- **0002 / 0003 的复现材料是「只读审计器」，不是一键复现脚本**。这两条缺陷的破坏面都是用户自己的安装（一次会回滚的升级、一份会被冲掉的配置），拿别人的机器去跑一遍不合适；审计器回答的是同一个问题——「我这份版本还会不会这样」，并且自带 `--selftest`（用缺陷版与修复版的合成源码验证判定器分得开）。
- 三条问题的**当前状态都是已修复**（0002 于 2.8.x、0003 于 2.5.0，本机实测）。留在这里的价值是：下次版本回退或市场发的是旧包时，一条命令就能确认缺陷有没有回来。



## 报告的三条纪律

1. **先只读取证**：数据库查询、日志、代码行号——不靠猜。
2. **区分「我的环境问题」和「产品缺陷」**：用对照实验（只改一个变量，其余不动），而不是只贴一段报错。
3. **给出最小修法**：能指出该改哪一行，就不写长篇建议。

## 环境

- Windows 11 + **DSH NEXT 桌面版 2.0.19-next**（内置 `@deepseek-ai/dsh` 0.2.1-rc.2，Electron + asar）；早期 0001 是在 DSH Desktop 2.0.17 上测的。
- 被测插件：`@modusensus/dsh-mneme` 0.9.3、`dsh-our-free-model` 2.5.x / 2.8.3、`dsh-bili-scroll` 0.1.7 / 2.5.0。
- 脚本用 DSH 自带的 Node 运行时（v24，`node:sqlite` 可直接只读查库），**不需要 `npm install`**。
- 所有取证脚本都以 `readOnly: true` 打开数据库、以只读方式读源码，不会写入被测产品。
- 审计类脚本都带 `--selftest`：先用缺陷版与修复版的合成源码验证判定器分得开，再拿去判真机。
- 脚本不内置任何密钥：endpoint / key / model 全部走环境变量。

## 许可

MIT（见 [LICENSE](LICENSE)）。报告里的实测数据来自我自己的机器，脚本可自由复用。
