# skins-coldstart：冷启动时皮肤样式表超时被打成 500，boot 不重试就落回默认

> [English](README.en.md) · 中文

对应上游项目：**zhu1090093659/dsh-web** —— issue [#2085](https://github.com/zhu1090093659/dsh-web/issues/2085)。插件真身在 zhu1090093659/dsh-skins 的 `packages/skins/skin-center`（`@linxin666/dsh-client-ui-skin-center` 0.4.21）。完整报告：[reports/0007](../../reports/0007-skin-center-coldstart-fallback.md)。

## 这个缺陷长什么样

用户的原话：「为什么每次 dsh 重启，皮肤都会被改为默认皮肤？自己设置的皮肤失效？」

三段事实拼起来就是答案：

- **选择没丢。** `~/.dsh/skin-center-active.json` 里一直是 `{"active":"tight-sidebar"}`，`GET /api/skin-center/v2/active` 也一直回答 `tight-sidebar`，皮肤文件完好，catalog 200。
- **丢的是冷启动那一次加载。** 皮肤 CSS 要先过 lightningcss 白名单转换，**每个请求 fork 一个短命 worker**，预算 **10 s**（`lib/index.js:1824` / `:1892`）；冷启动后第一个请求实测 **14.59 s** ⇒ `serveStylesheet()` 返回 `500 css-transform-failed`。
- **渲染端不重试。** `bootSkinRuntime()` 的 catch 只做一次 `adopt(null, null)`（`lib/client.js:1768-1770`）⇒ `removeAttribute('data-dsh-skin')`（`:1524-1538`）⇒ 官方默认。

结果就是同一个没变过的选择，在第二次（热）加载时正常应用，在第一次（冷）加载时被丢掉 —— 用户感知成「皮肤被重置了」。

## 为什么不给「一键复现」

这条的复现条件是**冷启动 + 首请求打满预算**，两个都不是靠点一下就能造出来的：热进程里怎么切都成功（实测首请求 14.59 s，之后 0.331 / 1.382 / 0.644 s），一旦缓存热了缺陷就消失。所以这里给的是**判定器**：它回答的更朴素 —— **我这台机器上的这个版本，还会不会在冷启动时把皮肤丢掉。**

## 用法

```bash
node audit-coldstart.cjs                  # 自动找 ~/.dsh/profiles/<profile>/node_modules/@linxin666/dsh-client-ui-skin-center
node audit-coldstart.cjs --dir <插件目录>   # 指定安装目录（多版本并存时用）
node audit-coldstart.cjs --logs <目录>      # 指定日志目录（默认 ~/.dsh/logs）
node audit-coldstart.cjs --active <文件>    # 指定 skin-center-active.json
node audit-coldstart.cjs --probe [url]     # 唯一会联网的选项：打本机 GUI 量首个请求耗时
node audit-coldstart.cjs --json            # 机器可读
node audit-coldstart.cjs --selftest        # 只跑判定器自检（合成数据 6 例），不扫机器
```

零依赖、只读：不加载插件、不连宿主、不写任何文件。退出码 `0` = 扫描完成（**有没有缺陷不影响退出码**），`1` = `--selftest` 没通过，`2` = 参数或环境错误。

## 判定项

| 项 | 查什么 | 修好的样子 |
|---|---|---|
| **A（结论项）** | 落默认的 `adopt(null, null)` 之前 600 字符内有没有 `for` / `while` / `retry` / `backoff` / `attempt` / `setTimeout` / `sleep` | 有 —— 例如 1 s / 3 s / 6 s 退避后仍失败才落默认 |
| **B（结论项）** | `SKIN_CSS_REQUEST_TIMEOUT_MS` 是否 ≥ 30000，或存在 `prewarm` / 预热 | 放宽或预热 —— 冷启动首请求不再被预算打断 |
| C（参照项） | `~/.dsh/logs` 里 `stylesheet load failed` / `previous skin intact` 的计数与日期 | 只用来佐证「确实是每次冷启动都犯」，不参与结论 |
| D（参照项） | `skin-center-active.json` 里的 `active` | 非空 —— 佐证「选择没丢，是运行期拉取失败」 |

结论三档：`FIXED`（A 成立）／`PARTIAL`（只放宽预算或预热，一次性失败仍会落默认）／`DEFECT`（两者都没有）。

## 本机实测（2026-11-23，profile `desktop`，Windows 11 + DSH NEXT 0.4.21）

```
皮肤中心冷启动回退 · 只读审计

插件目录：~/.dsh/profiles/<profile>/node_modules\@linxin666\dsh-client-ui-skin-center
版本：0.4.21
  ❌ [A] 落默认前无循环/退避/重试：一次性 adopt 失败即清皮肤
  ❌ [B] 预算仍是 10000ms（冷启动首请求实测 14.59s 打不住）
  结论：DEFECT

宿主日志：~/.dsh/logs（6 个 .jsonl）
  ❌ [C] stylesheet load failed ×9，switch failed ×9，日期：2026-11-16 / 2026-11-17 / 2026-11-18 / 2026-11-20 / 2026-11-23
  ❌ [D] active=null（initialized=true）

说明：[C] 是参照项（读的是历史日志），结论只由 [A] 决定、[B] 判断是否被绕开。
（上面的路径已把本机用户名隐去、归一化成 `~/.dsh` 与 `<profile>`，其余逐字保留。）
脚本不改任何文件、不改配置；--probe 是唯一会联网的选项，且只打本机 GUI。
```

`[D]` 的 `active=null` 有个背景：写这份材料时用户已经**手动切回官方默认**（为了截官方默认外观的图），不是失败的一部分。失败当时 `active` 与 `GET /active` 都是 `tight-sidebar` —— 这也是为什么它被列为**参照项**而不是结论项。

自检（`--selftest`，判定器分不分得开缺陷形状与修复形状）：

```
  ✅ A 缺陷形状 ⇒ 无重试
  ✅ A 修复形状 ⇒ 有重试
  ✅ B 缺陷形状 ⇒ 预算 10000
  ✅ B 修复形状 ⇒ 预算 60000 且判为放宽
  ✅ C 日志扫描 ⇒ 数到 1 条
  ✅ D active 解析
selftest: 6/6 通过（判定器分得开缺陷形状与修复形状）
```

## 局限（重要）

- **A 是词法判据。** 官方若把重试挪进 `adopt()` 内部、或改成 `queueMicrotask` / `Promise` 链，A 会判成「无重试」—— 这时要人工看一眼再下结论。
- **B 只看常量。** 如果修法改成由宿主统一预热、或改成运行时自适应预算，常量仍是 `1e4` 却已不致命，B 会误报；此时以实际重启体感 + C 为准。
- **C 读的是历史日志。** 装上新版本后旧失败仍会计数，它只回答「这台机器历史上犯过几次」。
- **不判断白名单本身。** 白名单拒绝是 422 `css-whitelist-violation`，与本条（500 超时）是两件事；脚本不评价皮肤 CSS 合不合规。

## 一句话总结

台词是「皮肤被重置了」，真相是「皮肤被读丢了 —— 启动时只有一次机会，而第一次机会超了 10 秒预算」。
