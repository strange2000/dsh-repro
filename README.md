# dsh-repro

> [English](README.en.md) · 中文

给 DSH 插件生态报 issue 时用的**实测与复现材料**。每个报过的 issue 对应一个编号：报告原文 + 可以直接跑的取证/复现脚本 + 原始数据口径。

目的只有一句话：把「我说我测到了」变成「你可以在这里自己重跑一遍」。

## 收录标准

- **进索引**：能定位到具体代码位置，或能写出具体可观测判据的 issue。纯功能建议、只描述观感的，不进来。
- **进 `repro/`**：缺陷能用一条命令自动判定，且这个判定对别人有实际价值（自己那份版本还会不会中招）。
- **不收**：与 DSH 生态无关的项目；无法判定的偶发现象（只登记，不深挖）。
- 「状态」列写的是**上游 issue 的状态**，不是我这边的进度。

## 索引

按上游项目分组。编号是稳定的，链接不会因为重排失效。

### slow-stack/mneme

| 编号 | 上游 issue | 一句话根因 | 判据 / 材料 | 状态 |
|---|---|---|---|---|
| 0001 | [#493](https://github.com/slow-stack/mneme/issues/493) | 转录裸放 user 消息，模型当成「该我回话了」；解析失败后确定性重试同一窗口 | [`repro/mneme-0001/`](repro/mneme-0001/) 取证脚本 + 三臂对照实验｜[报告](reports/0001-mneme-summarize-invalid-json.md) | closed |

### c1overzz/dsh-bili-scroll

| 编号 | 上游 issue | 一句话根因 | 判据 / 材料 | 状态 |
|---|---|---|---|---|
| 0003 | [#47](https://github.com/c1overzz/dsh-bili-scroll/issues/47) | `pythonPath` 被宿主启动快照压回 `"python"`（商店存根 exit 9009）/ `saveCfg` 整份写回 / 桌面版 CLI 只在 `app.asar` 内 + headless overlay 关了三服务 | [`repro/bili-0003/`](repro/bili-0003/) 只读审计（6 项判定）｜[报告](reports/0003-dsh-bili-scroll.md) | open |

### Ebony-Vinyl/dsh-our-free-model

| 编号 | 上游 issue | 一句话根因 | 判据 / 材料 | 状态 |
|---|---|---|---|---|
| 0002 | [#427](https://github.com/Ebony-Vinyl/dsh-our-free-model/issues/427) | 宿主暴露不出可枚举 ESM 缓存 ⇒ `purgeCaches` 清 0 个 ⇒ 兜底 `import()` 的 query 被 loader 规范化掉 ⇒ 拿到旧模块 ⇒ 版本断言 throw ⇒ updater 把「热激活失败」当「升级失败」而 `restoreBackup()` | [`repro/ofm-0002/`](repro/ofm-0002/) 只读审计（A/C 为结论项）｜[报告](reports/0002-dsh-our-free-model.md) | closed |

### 整理中（已报、待入库）

这几个项目的 issue 还没整理进上表，先列在这里，免得看起来像没报过：

| 项目 | 已报 | 状态 |
|---|---|---|
| [zhu1090093659/dsh-web](https://github.com/zhu1090093659/dsh-web) | #1968 / #1969 中继 503；#1954 / #1955 `settings.section` id 被抢占 | 全 closed |
| [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) | #1574 空闲反复退出；#1532 市场永久「新版等待中」 | 全 closed |
| [GDWhisper/dsh-ntr](https://github.com/GDWhisper/dsh-ntr) | #2 ACP 审批无提示挂起；#3 `mcpServers: []` 硬编码 | 全 closed |
| [MichengAI/dsh-archive-manager](https://github.com/MichengAI/dsh-archive-manager) | #91 `settings.section` 注册冲突未防护 | closed |
| [c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) | #78 / #79 / #80 2.0.1 的三处（判重表 / 白名单 / perDay）；#82 建议 | 三条 closed，#82 open |

## 两处补记

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
