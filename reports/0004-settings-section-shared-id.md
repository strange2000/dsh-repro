# 共享 `settings.section` id：一条冲突，两侧都要防守

> [English](0004-settings-section-shared-id.en.md) · 中文

<!-- tl;dr-en -->
> **TL;DR**
> - Two DSH plugins collided on the same `settings.section` id (`archived-sessions`): the claimer registered first and swallowed the collision in `try/catch`, the loser threw `Uncaught Error` and aborted its own client init.
> - The user-visible symptom is not an error — it is a settings page that silently is not there.
> - The real defect is the shared-id contract, not either plugin: an id can have one registrant per list slot, so **the claimer must degrade loudly and the registrant must tolerate being occupied**.
> - `repro/settings-sections/scan-sections.cjs` is the ruler: it reads client bundles only, lists every `settings.section` registration (id / order / swallowed), and judges `CONFLICT` / `SUSPECT` / `CLEAN`.
> - Measured on this machine 2026-11-08: 16 sections from 16 packages, **0 id collisions** — both plugins have since moved to their own namespace, so the defect shape is gone but the contract is still unenforced.

---

## 现象

用户视角只有一句话：**某个插件的设置页没了**。

不是报错弹窗，不是功能半残 —— 整个 section 不存在。启动期的控制台上留一条 `Uncaught Error`，之后再无痕迹。用户通常的反应是「插件坏了」或「这版把这个功能删了」，而不是「有两个插件抢了同一个 id」。

这条路径上有两个不同的失败形态（对应上游 [#1954](https://github.com/zhu1090093659/dsh-web/issues/1954) / [#1955](https://github.com/zhu1090093659/dsh-web/issues/1955) 与 [MichengAI/dsh-archive-manager#91](https://github.com/MichengAI/dsh-archive-manager/issues/91)）：

| 侧 | 做法 | 结果 |
|---|---|---|
| 抢占方 | 注册共享 id `archived-sessions`（priority 0），用 `try/catch` 包住注册 | 自己抢到位置；被顶掉的一方**零提示** |
| 被占方 | 注册时不做任何冲突防护 | 撞同 id 同 priority 抛 `Uncaught Error`，**并中断自身 client 初始化** —— 连它自己的设置页也打不开 |

关键点：**两侧都「按自己的逻辑正确」**。抢占方觉得自己在容错（不让一个失败拖垮整个面板），被占方觉得自己没做错（凭什么是我的问题）。冲突的根不在任何一侧的代码风格，在共享 id 这件事本身没有契约。

## 判据：静态扫描认定，不靠猜

面板里看不到的东西，代码里是看得到的。`repro/settings-sections/scan-sections.cjs` 只读客户端 bundle：

- 按 DSH 插件约定用 `package.json` 的 `exports["./client"]` 找客户端入口；
- 从 bundle 里抽 `slots.register({ name, id, order })` 的字面量；
- 判断这条注册是不是被 `try/catch` 包着（`swallowed`）；
- 在扫描结果上加判定：**同 id 同 order → 硬冲突**、**同 id 不同 order → 软冲突**、**同包多处 register → 同包重复**，结论三档 `CONFLICT` / `SUSPECT` / `CLEAN`。

```bash
node repro/settings-sections/scan-sections.cjs            # 扫 ~/.dsh/profiles 下所有 profile
node repro/settings-sections/scan-sections.cjs --json     # 机器可读（含 verdict / hard / soft / selfDup）
node repro/settings-sections/scan-sections.cjs --selftest # 先验判定器本身（7 个合成用例）
```

判定器带 `--selftest`，因为它自己也会错 —— 首跑就抓到一次：扫描阶段把同包多处 `register` 合并成一行并记 `sites`，判定阶段却按「多行」识别同包重复，那条分支永不触发，脚本会稳定输出「同包重复：无」（真相是 4 处）。**先信自检，再信结论。**

## 本机实测（2026-11-08，profile `desktop`）

```
532 个包 → 414 个有客户端入口 → 读 413 个文件 → 16 个包注册 16 个 settings.section（另有 5 个 settings.section.icon）

判定 CLEAN
硬冲突   无
软冲突   无
同包重复 4 处（archive-manager / bili-scroll / skills-manager 各 2 处，含 icon 槽位）
注册被吞 10 处，其中 0 处涉及冲突
```

三件值得记的事实：

1. **`archived-sessions` 这个 id 已经没人注册了。** `@linxin666/dsh-session-archive@0.4.16` 换成了自己的命名空间 `dsh-session-archive`，`@michengai/dsh-archive-manager@1.2.8` 换成了 `archive-manager`。当年那两条 issue 的冲突形态在本机消失 —— 修法是有效的，而且两边都改了。
2. **`order` 撞车不是冲突。** `archive-manager` / `dsh-email` / `dsh-notify-me` 三家都用 `order: 45`，id 各不相同，只是并列排在同一位置。判据永远是 **id**。
3. **10 处注册被 `try/catch` 包着，0 处涉及冲突。** 这些是各插件自己的防御性写法，此刻不构成隐患 —— 但代价是：**真撞车时用户不会收到任何提示**。0016 的病根正是这个「静音键」。

## 双向最小修法

**抢占方（要注册的一方）**

1. 首选自己的命名空间：`<pkg>-<section>`，而不是 `archived-sessions` 这种描述性通用词。描述性 id 天生是公共资源。
2. 必须共享时，先查再注册，失败要**说人话**：注册被拒 → 降级到独立 id 并 `warn('[pkg] settings.section "x" 已被占用，改用 "pkg-x"')`，而不是 `try { … } catch {}` 静默吞掉。
3. 如果确实要顶掉别人，明确写出来这是抢占（日志里点名被顶掉的 id 与 owner），让排障的人一眼看到因果关系。

**被占方（要防被顶的一方）**

1. 注册前检查 id 是否已被占用；被占用时不要抛到初始化之外 —— 用独立 id 退让，或把 section 挂到自己的子入口下。
2. `Uncaught Error` 不能中断整个 client 初始化：一个 section 注册失败不该让插件的其余功能一起消失。

**宿主/框架层（真正的根治点）**

- 同 id 二次注册应当有**可观测**行为：明确 warn 或明确 throw，并把 owner 与 id 一起打出来。当前形态下 `try/catch` 一包就什么都不剩，等于把契约交给插件自觉。
- 公开的扩展点（slot 的注入/注册 API）应当鼓励命名空间化 id，减少「描述性 id 撞车」这一类必然事件。

## 局限（写在结论前面）

静态扫描读的是**字面量**：动态注册（按需 `register`、跨文件拼 id）只能看到「它有能力注册」，不代表此刻真的注册了；反过来，运行时通过 overlay 注入的注册也可能不在 bundle 里。表里标 `×N` 的是同包多处 register 被合并的行，`·` 是取不到值的字段。

所以扫描器的定位是**尺子**，不是判官：它告诉你「这台机器上有没有同 id 撞车」，不告诉你「某个插件一定坏了」。

## 与「三条纪律」的关系

- **先只读取证**：不加载插件、不连宿主、不写盘，只读 bundle 字面量。
- **区分环境问题与产品缺陷**：`archived-sessions` 消失是本机已修的证据，不能拿它去说上游仍然有 bug；反过来，上游修了也不代表所有用户都升级了 —— 这正是扫描器存在的意义。
- **给最小修法**：上面三节，每节都能在一小时内落地。
