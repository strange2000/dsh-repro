# settings.section 注册扫描器

> [English](README.en.md) · 中文

`settings.section` 是 DSH 客户端的**共享槽位**：所有插件把自己的设置页塞进同一份导航列表里。共享就意味着会撞车，而撞车的两种后果都很糟：

- **抢占方静默兜底**（被抢的一方零提示整块丢设置页）—— 见 [0016](../../README.md)（dsh-web #1954 / #1955）。
- **注册方不做防护**（撞同 id 同 priority 直接抛 `Uncaught Error`，并中断自己的 client 初始化）—— 见 [0017](../../README.md)（archive-manager #91）。

这个脚本回答一个很朴素的问题：**我这台机器上，到底谁注册了哪个 id、order 多少、注册语句有没有被 try/catch 吞掉。**

## 用法

```bash
node scan-sections.cjs                  # 扫 ~/.dsh/profiles 下所有 profile
node scan-sections.cjs --root <dir>     # 指定 profile 目录，或直接指定某个 node_modules
node scan-sections.cjs --json           # 机器可读（每行带 file / sites / swallowed）
node scan-sections.cjs --all-slots      # 不只 settings.section，列出所有槽位注册
node scan-sections.cjs --selftest       # 只跑判定器自检（合成数据），不扫机器
```

零依赖，只读文件：不加载插件、不连宿主、不写任何东西。退出码 `0` = 扫描完成（**有没有冲突不影响退出码**），`1` = `--selftest` 判定器没通过，`2` = 参数或环境错误。

## 本机实测（2026-11-08，profile `desktop`）

```
扫描 532 个包 → 414 个有客户端入口 → 读入 413 个文件
settings.section 注册共 16 处，来自 16 个包
```

| id | order | 注册被 try/catch 吞掉 | 包@版本 |
|---|---|---|---|
| `acp-agents` | 120 | · | dsh-ntr@0.4.1 |
| `agent-persona` | 22 | · | dsh-agent-persona@0.2.2 |
| `archive-manager` | 45 | yes | @michengai/dsh-archive-manager@1.2.8 |
| `better-sidebar` | 100 | · | dsh-better-sidebar@0.30.1 |
| `bili` | 100 | · | billion-context@0.1.213 |
| `bili-scroll` | 30 | · | dsh-bili-scroll@2.5.0 |
| `dsh-connect-workbuddy` | 35 | · | dsh-connect-workbuddy@5.20.32 |
| `dsh-email` | 45 | · | dsh-email@0.24.0 |
| `dsh-notify-me` | 45 | · | dsh-notify-me@1.18.0 |
| `dsh-session-archive` | · | yes | @linxin666/dsh-session-archive@0.4.16 |
| `im-assistant` | 40 | · | @michengai/dsh-im-connect@1.0.28 |
| `orb` | 25 | yes | dsh-orb@0.2.1 |
| `our-free-model` | 35 | · | dsh-our-free-model@2.8.3 |
| `pet-config` | 30 | · | dsh-pet@0.4.7 |
| `skills-manager` | 25 | yes | @michengai/dsh-skills-manager@1.3.0 |
| `web-ui-plugins` | 110 | yes | @linxin666/dsh-client-ui-web-ui-settings@0.4.16 |

三个观察：

1. **同一 id 被多个包注册的情况：零。** 也就是说本机此刻是健康的 —— 这与 0016 / 0017 都已修复一致。
2. `archived-sessions` 这个 id **现在没有任何包注册**：`@linxin666/dsh-session-archive@0.4.16` 已改成自己的命名空间 `dsh-session-archive`，`@michengai/dsh-archive-manager@1.2.8` 改成了 `archive-manager`。两条 issue 里的冲突形态在本机已经消失。
3. **order 撞车不等于冲突**：`archive-manager` / `dsh-email` / `dsh-notify-me` 都用 `order: 45`，但 id 不同 —— 它们只是并列排在同一位置，不会互相顶掉。真正的判据是 **id**，不是 order。

## 局限（重要）

这是**静态**扫描：读的是客户端 bundle 里的注册字面量。

- 动态注入的插件（在 `slots.inject` 回调里按需 `register`）只能看到字面量，不代表它此刻真的注册了；名单里有 `×2` 的包正是「挂载期注册一次 + `slots.inject` 里再注册一次」这种双路径写法。
- 常量形式的 id（`id: SECTION_ID`）靠同文件内的 `const` 字面量解析；跨文件拼出来的 id 会显示成 `·`，需要人工看一眼。
- 它判断「有没有可能撞」，不判断「撞了之后宿主怎么处理」—— 后者取决于注册顺序与宿主实现，得看运行时。

## 判定：三类问题，性质完全不同

扫描之上加了一层判定（`judge()`，纯函数，`--selftest` 可单独验它）：

| 判定 | 含义 | 后果 |
|---|---|---|
| **硬冲突** hard | 同 id **同 order**，来自不同包（order 双方都缺失也算） | 两个设置页要挤同一个位置，后注册者必然受影响 |
| **软冲突** soft | 同 id **不同 order**，来自不同包 | 位置不同但仍共用一个 id，结局取决于宿主是「覆盖」还是「报错」—— 0016 / 0017 正是这两种结局 |
| **同包重复** selfDup | 同一个包对同一个 id 注册多次 | 通常是「挂载期一次 + `slots.inject` 里一次」的双路径；两条都触发时，第二次注册的成败没人管 |

结论三档：`CONFLICT`（有硬冲突）／`SUSPECT`（只有软冲突）／`CLEAN`（无同 id 撞车）。

**「注册被 try/catch 吞掉」不单独算问题，它会稀释上面三类的可见性**：冲突确实发生了，但注册方静默失败，用户看到的现象只是「设置页没了」—— 这条正是 0016 的核心。所以输出里会单独点出「吞掉的注册中有几处涉及冲突」。

## 本机判定结果（2026-11-08，profile `desktop`）

```
判定 CLEAN
硬冲突       无
软冲突       无
同包重复     4 处 —— archive-manager / bili-scroll / skills-manager 各 2 处（archive-manager 的 icon 槽位也是 2 处）
注册被吞     10 处，其中 0 处涉及冲突
```

也就是说：这台机器此刻没有 id 撞车，0016 / 0017 那类问题在本机不存在。10 处 try/catch 全是各插件自己的防御性写法，不构成隐患 —— 但**它们的代价是：真有冲突时你不会收到任何提示**。

## 自检抓到的 bug（值得记一笔）

`--selftest` 第一次跑就失败了：「同包注册两次」那条用例判出 `selfDup=0`。

原因是两步对「一处注册」的定义不一致：扫描阶段把同一个包的多处 `register` **合并成一行**并记 `sites=2`，而判定阶段还在用「同一 id 出现多行」来识别同包重复 —— 合并之后永远只有一行，这条分支就永远不触发。修法是让判定阶段也认 `sites > 1`。

这正是自检的意义：如果不写这条用例，这个脚本会稳定输出「同包重复：无」，而真相是 4 处。

## 用法补充

```bash
node scan-sections.cjs --selftest   # 只跑判定器自检（合成数据，7 个用例），不扫机器
                                    # 退出码 0 = 自检通过；1 = 判定器有问题，先修它再信结论
node scan-sections.cjs --json       # 含 verdict / hard / soft / selfDup / swallowed
```

