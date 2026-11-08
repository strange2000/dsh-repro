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
| 0004 | [#534](https://github.com/slow-stack/mneme/issues/534) | dream 决策层两层账不一致：run 层 19 轮里 17 轮校验期整轮失效、2 轮 `ok` 但 `applied=0`（200 条全 `keep`），而 LLM 审计层记 18 success ⇒ 按审计统计会得出「成功率 95%」的相反结论；失败轮不落原始决策 | —（仅登记） | closed |
| 0005 | [#553](https://github.com/slow-stack/mneme/issues/553) | `MemoryDrawer` 的 useState 区漏了 `provenance`（`lib/client.js:6484`），但组件内在 `:6522` 就调 `setProvenance(null)` ⇒ 打开记忆详情必崩 `ReferenceError: provenance is not defined`，渲染进程挂掉、DSH 重启，100% 复现 | —（仅登记） | closed |
| 0006 | [#557](https://github.com/slow-stack/mneme/issues/557) | `dream_runs` 是全库唯一没有 DELETE 路径的表（`lib/store.js` 只清理 `recall_runs` / `llm_audit_logs`），四个 `*RetentionDays` 也都不覆盖它；实测占库约 43% 的页、`input` 平均 79 KB/轮，且单行体积×轮数双涨 = 超线性，还会成倍放大每张热快照 | —（仅登记） | open |
| 0007 | [#578](https://github.com/slow-stack/mneme/issues/578) | `locateCliJs()`（`lib/wiki/t1.js:110`）硬编码 `resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`；DSH NEXT 的 asar 顶层没有 `dsh/` 这一层，真正的 headless 入口是 `app.asar/lib/desktop-cli.js` ⇒ T1 必失败，且只报「headless 退出码 1：(无输出)」，子进程根本没起来所以自查成本极高 | —（仅登记） | open |
| 0008 | [#579](https://github.com/slow-stack/mneme/issues/579) | `choro_module_map` / `choro_read_page` / `choro_search` 的错误分支直接 `return { error, hint }`，而三者都声明了 `additionalProperties: false` 的强 schema ⇒ 宿主一律判 `invalid output`，用户看不到真实原因（没登记 / 多仓库歧义 / 页不存在） | —（仅登记） | closed |
| 0009 | [#581](https://github.com/slow-stack/mneme/issues/581) | 仓库身份拿本机绝对路径当键（`lib/wiki/t0.js:47` 存 `realpathSync(resolve(repoRoot))`，T1 在 `t1.js:239` 要求逐字符相同）⇒ 双系统共用一个 `memory.db` 时地志无法跨端复用；在另一端再跑一次 T0 就多一条记录，从此不带 `repo` 调用即 `repo-ambiguous`（而它的错误载荷又不合 schema，见 0008） | —（仅登记） | open |
| 0010 | [#582](https://github.com/slow-stack/mneme/issues/582) | `dsh-mneme-wiki` 自带的手写迷你渲染器把 `\|` 开头的行只做成等宽 `div`（`lib/client.js:10227` + `.mneme-wikitablerow` 的 `white-space:pre`）、不剥 `<!-- CHORO:T1:START -->` 这类 HTML 注释、front matter 的 `status` 在 T1 后不回写（库里 `choro_pages` 已 `enriched`、页面仍是 `skeleton`）⇒ 模块页上看到的是 Markdown 源码而不是排版后的页面 | —（仅登记） | open |

### c1overzz/dsh-bili-scroll

| 编号 | 上游 issue | 一句话根因 | 判据 / 材料 | 状态 |
|---|---|---|---|---|
| 0003 | [#47](https://github.com/c1overzz/dsh-bili-scroll/issues/47) | `pythonPath` 被宿主启动快照压回 `"python"`（商店存根 exit 9009）/ `saveCfg` 整份写回 / 桌面版 CLI 只在 `app.asar` 内 + headless overlay 关了三服务 | [`repro/bili-0003/`](repro/bili-0003/) 只读审计（6 项判定）｜[报告](reports/0003-dsh-bili-scroll.md) | open |
| 0011 | [#78](https://github.com/c1overzz/dsh-bili-scroll/issues/78) | `parseSeenTable()` 只认表格行，而章程没规定 `seen.md` 的写法 ⇒ 一百多条记录一条也读不出来，面板「它刷过的视频」恒空 | —（仅登记） | closed |
| 0012 | [#79](https://github.com/c1overzz/dsh-bili-scroll/issues/79) | `POST /api/bili-duty/config` 按一张 1.x 时代的白名单重建 patch，2.0 新增字段（`dmWatch` / `favFolderId` / `personaPrompt`）被静默过滤 ⇒ 面板保存后 5 秒轮询把开关弹回；每次保存还附带 `{"keywords":[]}` 清空关键词。反证：MCP `bili_config` 不经白名单，同一台机器上工具能写、面板写不进 | —（仅登记） | closed |
| 0013 | [#80](https://github.com/c1overzz/dsh-bili-scroll/issues/80) | 「不写日报」档（`reportLevel=off`）下 `countPickedToday()` 只数报告文件 ⇒ 恒 0 ⇒ `perDay` 闸门永不成立；唯一保底只约束定时窗口，`runDuty('manual')` 不受约束 ⇒ 上限 5 的一天挑到 10 条，面板 `pickedToday` 还显示 0 | —（仅登记） | closed |
| 0014 | [#82](https://github.com/c1overzz/dsh-bili-scroll/issues/82) | 建议类：值班轮子进程 `cwd` 写死插件家（`const cwd = stateDir`）⇒ 它开的会话全落「未分组」；而 `WorkspaceRegistry.candidateMatches()` 要求 `realpath(header.cwd) === 工作区 path`，事后改 `workspace.json` 会被下次启动过滤掉，所以只能靠 cwd 落对位置（作者自带 workaround：`sessionWorkspace` 键 + spawn 时给 `danger-full-access` + 启动 8 秒后收编扫描） | —（仅登记） | open |

### Ebony-Vinyl/dsh-our-free-model

| 编号 | 上游 issue | 一句话根因 | 判据 / 材料 | 状态 |
|---|---|---|---|---|
| 0002 | [#427](https://github.com/Ebony-Vinyl/dsh-our-free-model/issues/427) | 宿主暴露不出可枚举 ESM 缓存 ⇒ `purgeCaches` 清 0 个 ⇒ 兜底 `import()` 的 query 被 loader 规范化掉 ⇒ 拿到旧模块 ⇒ 版本断言 throw ⇒ updater 把「热激活失败」当「升级失败」而 `restoreBackup()` | [`repro/ofm-0002/`](repro/ofm-0002/) 只读审计（A/C 为结论项）｜[报告](reports/0002-dsh-our-free-model.md) | closed |

### zhu1090093659/dsh-web

| 编号 | 上游 issue | 一句话根因 | 判据 / 材料 | 状态 |
|---|---|---|---|---|
| 0015 | [#1968](https://github.com/zhu1090093659/dsh-web/issues/1968) / [#1969](https://github.com/zhu1090093659/dsh-web/issues/1969) | dsh-market.com 边缘中继间歇返回 503 `relay storage unavailable`，而 `relay.state` 仍报 `running`；手机启动要拉 111 个前端模块，任一失败启动器就不切页 ⇒ 永久停在 `Loading plugins…`。判据是**同一路径、同 111 个 URL 的并发对照**：6 并发 111/111 通过，紧接着串行 22/111 失败（17 条 `relay storage unavailable` + 5 条空响应），临时 `*.trycloudflare.com` 隧道 111/111 通过 | —（仅登记） | closed |
| 0016 | [#1954](https://github.com/zhu1090093659/dsh-web/issues/1954) / [#1955](https://github.com/zhu1090093659/dsh-web/issues/1955) | `packages/dsh-session-archive` 抢占 `settings.section` 的共享 cell id `archived-sessions`（priority 0）并用 `try/catch` 静默兜底 ⇒ 第三方归档插件在**零提示**下整块丢失设置页，只留一条启动期 `Uncaught Error`；名字相同的 id 在同一个 list slot 上只能有一个注册方，谁先注册谁独占 | [reports/0004](reports/0004-settings-section-shared-id.md) · [扫描器](repro/settings-sections/README.md)（与 0017 是同一冲突的两侧） | closed |

### MichengAI/dsh-archive-manager

| 编号 | 上游 issue | 一句话根因 | 判据 / 材料 | 状态 |
|---|---|---|---|---|
| 0017 | [#91](https://github.com/MichengAI/dsh-archive-manager/issues/91) | 同一冲突的另一侧：插件注册 `settings.section` 时不做冲突防护，撞上同 id 同 priority 直接抛 `Uncaught Error`，并**中断自身 client 初始化**（所以它自己的设置页也打不开）。这一对说明「共享 id」需要注册方与消费者双向防守 | [reports/0004](reports/0004-settings-section-shared-id.md) · [扫描器](repro/settings-sections/README.md)（与 0016 是同一冲突的两侧） | closed |

### GDWhisper/dsh-ntr

| 编号 | 上游 issue | 一句话根因 | 判据 / 材料 | 状态 |
|---|---|---|---|---|
| 0018 | [#2](https://github.com/GDWhisper/dsh-ntr/issues/2) | NTR 模式下 agent 发起「需审批」的工具调用后，桥接层没把 ACP 的 permission 请求转成宿主审批 UI ⇒ 聊天区无审批卡、无提示、无占位，界面只表现为「一直在转」，会话永久挂起（agent 侧只剩每 30s 的内存心跳），最后只能杀进程。判据：agent 侧日志有 `[tool-permission] ASK tool=Bash mode=default`，此后无任何记录 | —（仅登记） | closed |
| 0019 | [#3](https://github.com/GDWhisper/dsh-ntr/issues/3) | `session/new` / `session/load` 三处调用（`lib/bridge.js` L531 / L588 / L736）把 `mcpServers` **写死成 `[]`**，而 `agents.json` 的 schema（`validateAgentDef`）压根没有 mcp 字段 ⇒ 对端 agent 即使声明 `mcpCapabilities: { http: true, sse: true }` 也拿不到任何 MCP 工具。「管道已经在了，只是没接」——ACP SDK 这侧类型与校验全支持 | —（仅登记） | closed |

### anywhere-labs/dsh-desktop

| 编号 | 上游 issue | 一句话根因 | 判据 / 材料 | 状态 |
|---|---|---|---|---|
| 0020 | [#1532](https://github.com/anywhere-labs/dsh-desktop/issues/1532) | Desktop 给 pnpm 注入 `pnpm_config_minimum_release_age=0`，而市场自己的「最低发布龄」判定因此返回 `unknown` 并 fail-closed ⇒ 每个待更新插件永久显示「新版等待中」、连「更新」按钮都不给。判据：`dsh-web-all` 0.4.8 → npm 0.4.11 已发布 38 小时仍不解锁。不崩不报错，极难自查 | —（仅登记） | closed |
| 0021 | [#1574](https://github.com/anywhere-labs/dsh-desktop/issues/1574) | 空闲时 Host 进程退出、界面落进恢复模式（「插件服务进程已退出，退出码 1」），5 天 13 次；栈指向 fail-loud 路径上的 `fatal load failure` / `MeshCallError: Call deadline exceeded`（迟到的 `unhandledRejection`）。**只登记不深挖**：这是跨天偶发，没有可判定的单点判据，而 fail-loud 本身是 #1158 的设计，要等上游区分「已结束请求的迟到超时」与「真正的致命错误」 | —（仅登记） | closed |

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
