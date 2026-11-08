# ofm-0002：应用内升级每次都回滚（热重载永远确认不了新版本）

对应上游项目：[Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)，
完整报告在 [`../../reports/0002-dsh-our-free-model.md`](../../reports/0002-dsh-our-free-model.md)。

## 这个缺陷长什么样

桌面版宿主（Electron）暴露不出可枚举的 ESM 缓存，于是：

1. `purgeCaches()` 清出 **0** 个模块（`hot reload purging 0 cached module(s)`）；
2. 兜底 `import()` 带着 `?ofm-reload=` 参数重来一遍，但 loader 用 **resolved path** 做缓存 key，query 被规范化掉 ⇒ 拿到的是已经求值过的旧模块；
3. `replacement.version` 还是旧版本 ⇒ `activation version mismatch` → `throw`；
4. `updater` 把「热激活失败」当成「整次升级失败」⇒ `restoreBackup()`，把一份**已经装好、逐字节对过签名清单**的升级撤掉。

所以症状是「每次都升级失败」，而 `upgrade-state.json` 里 `diskRestored: true` —— 磁盘其实已经升级成功了，是回滚把它撤了。

## 为什么不给「一键复现」脚本

真正的复现要在一台机器上跑一次升级再让它回滚，而这个缺陷的破坏面正是**用户的安装**。所以这里给的是**只读审计**：它回答同一个问题（「我这份版本还会不会这样」），代价是零。

```bash
node audit-activation.cjs                  # 自动找 ~/.dsh/profiles/*/node_modules/dsh-our-free-model
node audit-activation.cjs --dir <插件目录>
node audit-activation.cjs --logs           # 顺便统计宿主日志里的证据行（找不到日志就跳过）
node audit-activation.cjs --json
node audit-activation.cjs --selftest       # 先验证判定器本身可信（离线）
```

它不执行插件代码、不联网、不写插件目录，只读 `src/reload.js`、`src/updater.js` 和 `upgrade-state.json`。

## 判定项

| 项 | 查什么 | 修好的样子 |
|---|---|---|
| A | `backup.esm.size === 0` 那个分支 | `return { restartRequired: true }` 收手，不再往下 re-import |
| B | `activation version mismatch` 断言（**仅参照**） | throw 通常还在，但 A 已先拦住 ⇒ 桌面版走不到；单看它会误判 |
| C | `updater` 侧认不认识 `restartRequired` | 认识 = 延迟激活已落地；不认识 = 热重载一失败就只能 `restoreBackup()` |
| D | `activate` 是否可选（仅参照） | `if (activate !== undefined)` —— 省略 activate 本来就是受支持路径 |

结论三档：`FIXED`（延迟激活已落地）/ `PARTIAL`（只修一半）/ `DEFECT`（仍会回滚）。

**`--selftest` 不是装饰**：它把报告里那段缺陷代码和修复后的形状各拼一份合成源码，喂给同一个判定函数，要求判出 `DEFECT` 和 `FIXED`。判定器连这两种形状都分不开的话，跑真机得到的结论也没意义。

## 实测（2026-11，本机 Windows 11）

```
插件目录：~/.dsh/profiles/desktop/node_modules/dsh-our-free-model
版本：2.8.3
  ✅ [A] 该分支 return { restartRequired: true } —— 不再往下 re-import
  · [B] throw 仍在（正常：A 已先拦住，走不到这里）
  ✅ [C] updater 里出现 restartRequired 字段/标记
  · [D] 省略 activate 是受支持路径
  小计：2/2 项通过
  结论：FIXED

upgrade-state.json：2.1.0 → 2.5.3，phase=complete  activated=false
  ⭐ 这是「装完、未热激活、等重启」的形态 —— 修复版应有的样子，不是失败。
```

即：**这个 issue 提的问题在 2.8.x 上已经修掉了**，而且修法就是报告里建议的那种（把「装好了但没能热激活」当成一种正常结局，而不是异常）。当年那个 `phase: rolled-back` + `diskRestored: true` 的形态已经见不到。

`--logs` 在本机扫了 14 个日志文件、0 行命中 —— 旧日志早已轮转，所以日志只能算旁证，主要判据是源码与状态文件。

## 等价的「绕过去」做法（受支持，但会动你的安装）

报告里的结论是：同一条流水线**只省掉热激活那一步**就能装成功，重启后完全生效。

```js
// 仅示意：真实调用要按你那份版本的导出名来写。会真的写入磁盘，别在不懂的机器上跑。
const { downloadManifest, parseManifest, verifyManifestSignature } = updater.deps   // 名字随实现而变
const manifest = parseManifest(downloadManifest(await fetchLatestIndex()), targetVersion)
verifyManifestSignature(manifest)
// ...stageRelease / verifyStaged / installStaged / verifyInstalled 都照原样
await apply({ version: targetVersion })      // ⚠️ 不传 activate
// 然后完全退出 DSH 再打开 —— 新版本由启动流程激活
```

`activate` 省略时流水线停在 `phase: 'complete'` / `activated: false`，文件已经在盘上且校验通过，下一次启动即生效。这也是审计脚本里 A、C 两项为什么是结论项：修复版正是把这条路变成默认结局。
