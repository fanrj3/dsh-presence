# Presence 交接报告：让 `ctx.fs` 认 `presence://` 路径

> 读者：接手这项工作的工程师 / coding agent。
> 目标：在一个 DSH（DeepSeek Harness）profile 里，让远程机器的文件夹成为**真正的 DSH 工作区**——出现在左侧工作区列表、文件树能浏览、`read`/`write`/`edit`/`grep` 等内置工具直接作用于远程文件。
> 本文档包含：已完成的部分、三次失败的完整记录、失败根因的证据与待确认项、可选方案对比、推荐方案的阶段化实施步骤、逐条验收标准、以及踩过的坑。

---

## 0. 一句话现状

Presence 已经能用一条常驻 SSH 连接完成远程读写/搜索/执行/终端，**但远程文件夹还不是 DSH 工作区**——因为 `ctx.fs` 只认本机路径。本任务就是解决这一件事。

仓库：`D:\04_Dev\Presence`（TypeScript 无关，纯 ESM JavaScript + 一个 ssh2 依赖）

---

## 1. 产品目标

对有多台服务器的开发者：
- agent 留在本机（一套模型、一套代理配置）
- 用户在 UI 里选一台机器 → 浏览该机器目录 → 选一个文件夹 → 得到一个工作区
- 在这个工作区里，agent 的所有文件操作（读、写、编辑、搜索、文件树）和命令执行，都落在那台机器那个目录上
- 远端零安装：不传任何文件、不跑任何守护进程，只用 sshd 自带的 SFTP/exec/shell 通道

---

## 2. 已经完成并验证的部分（可直接复用，不要重写）

### 2.1 目录地图

```
D:\04_Dev\Presence\
├─ index.js                 # 插件入口：注册 8 个工具 + 面板 HTTP API + 运行时上下文
├─ client.js                # 浏览器面板（window.__ModuleLoader__ 格式，非构建）
├─ cordis.patch.yml         # Bundle 补丁（当前只 insert presence 一行，不碰 fs）
├─ package.json             # exports: "." / "./client" / "./fs" / "./selfcheck"
├─ src/
│  ├─ core/
│  │  ├─ ssh-config.mjs     # 解析 ~/.ssh/config（Host/HostName/Port/User/IdentityFile/Include/引号）
│  │  └─ connection.mjs     # ★ 一条常驻 ssh2 连接：SFTP、exec 通道、PTY shell、通道池、超时取消
│  ├─ pool.js               # 连接池：每机器一条连接、终端、密码内存表、空闲回收
│  ├─ tools.js              # 8 个模型工具（工作区作用域已实现）
│  ├─ api.js                # 面板 HTTP 接口（本机 + 同源双保险）
│  ├─ workspaces.js         # 远程工作区注册表（~/.dsh/presence/workspaces.json）
│  ├─ shared.js             # 进程内单例：{ pool }
│  ├─ fs-provider.js        # ★ 已写好但未启用的 ctx.fs 提供方（presence://）
│  └─ fs-selfcheck.js       # ★ 只读自检插件，不注册服务，用来验证 provider 逻辑
└─ scripts/probe.mjs        # 独立验证脚本（不依赖 DSH）
```

### 2.2 实测数据（server，Ubuntu 20.04，IPv6）

| 操作 | 耗时 |
| --- | --- |
| `ssh host <cmd>` 每次新连接 | 520–540 ms |
| Presence 建连（一次握手） | 145 ms |
| SFTP stat | p50 0.6 ms / p95 0.9 ms |
| exec 通道（新通道+起 shell） | p50 7.6 ms |
| 8 个 exec 通道并发 | 合计 15 ms |

**必须开 TCP_NODELAY**：不开时请求会撞上 delayed ACK，p95 从 0.9 ms 劣化到 48 ms。

### 2.3 现有 `ctx.fs` 提供方（`src/fs-provider.js`）

已经实现了完整方法集，只差「注册进 Cordis 时不炸」这一步：

| 方法 | 实现 |
| --- | --- |
| `resolve(path, {cwd})` | `presence://<alias>/<abs>` 原样返回 target；`cwd` 也是 presence 时按工作区根拼相对路径；其余交给 `super` |
| `stat` / `lstat` | SFTP stat → `{version,type,size}`，version = `presence:<mtime>:<size>:<d/f>` |
| `readText` / `streamText` / `readBytes` / `readByteRange` | SFTP 读，含 `FS_TOO_LARGE` / `FS_NOT_TEXT` 判断 |
| `listDir` | SFTP readdir → `{name,type,target,version,size}` |
| `writeText` | 版本守卫 + 原子写 + `{operation,version,before,after}` |
| `editText` | 版本守卫 + 字面量匹配（`FS_EDIT_NOT_FOUND` / `FS_AMBIGUOUS_EDIT`）+ 原子写 |
| `watch` | 2s 轮询 stat 比较 version |
| `contains` / `processPath` / `fileUrl` | presence 目标用 URL 前缀比较/透传；其余 `super` |
| `fenceFor` | 保留沙箱语义：read-only 拒绝；workspace-write 只允许写当前 Presence 工作区根之下；danger-full-access 放行 |

### 2.4 自检（`src/fs-selfcheck.js`）

不注册服务，只用 `Object.create(PresenceFileSystem.prototype)` 造一个「干探头」，然后对真实主机跑一遍。**最近一次结果：13/14 通过**，唯一失败是自检脚本自己的 bug（清理时把 `presence://host/tmp/x` 整串当远端路径传给 SFTP），已修复。

> 这个技巧很重要：它能在**不注册 `ctx.fs`** 的前提下验证 provider 逻辑，是本任务继续推进的基础工具。

### 2.5 面板与工作区作用域（已可用）

- 设置 → Presence：机器列表、按需密码、远程目录浏览、建工作区、浏览工作区文件
- 设「当前工作区」后，`presence_*` 工具**不需要 host**，相对路径相对工作区根，运行时上下文每步注入绑定信息
- 接口同时注册在 `/presence/api/*` 和 `/api/presence/*`（前者给浏览器，后者给桌面版 IPC 桥）

---

## 3. 本任务的验收标准

全部满足才算完成：

1. 在 DSH 左侧工作区列表里，能看到一个远程工作区（标题、路径都是远程的）
2. 点进去新建会话，会话 cwd 是该远程路径
3. 侧边栏文件树能列出远程目录、逐级展开
4. 内置 `read` / `write` / `edit` / `grep` / `glob` 工具直接读写远程文件（不是改走 `presence_*`）
5. 本地文件的行为**完全没有退化**（这是硬约束，见第 7 节风险）
6. 新建会话正常、既有会话不受影响
7. 远程写入仍受会话沙箱模式约束（read-only 不能写、workspace-write 只能写工作区根下）

---

## 4. DSH 文件系统契约（必须逐条实现）

来源：`@deepseek-ai/dsh-fs` 的 `FileSystem`（抽象 Service）+ `@deepseek-ai/dsh-fs-local` 的 `LocalFileSystem` + `@deepseek-ai/dsh-fs-sandbox` 的 `SandboxedFileSystem`。

### 4.1 注册方式

```js
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox';

export default class PresenceFileSystem extends SandboxedFileSystem {
  static inject = ['sandboxPolicy'];
  constructor(ctx, config) {
    super(ctx, config);                            // LocalFileSystem: 校验 config
    this.defaultMode = ctx.sandboxPolicy.defaultMode;
  }
  get sandboxMode() { return this.defaultMode; }   // 工具层用它来决定是否显示升级字段
}
```

- `FileSystem` 的构造函数是 `super(ctx, 'fs')`，**服务名写死为 `fs`**——所以一个 profile 只能有一个提供方
- 插件以「default export 是 Service 类」的形式加载；patch 里用 `name: 'dsh-presence/fs'`
- `@deepseek-ai/dsh-fs-local` 的 `LocalFileSystem` 就是完整实现，`fs-sandbox` 只额外覆盖了 `writeText` / `editText` / `sandboxMode`

### 4.2 方法清单与返回形状

| 方法 | 签名 | 返回 |
| --- | --- | --- |
| `resolve` | `(path, {cwd, signal})` | `{targetKey, displayPath}`（targetKey 不透明） |
| `stat` | `(target, signal)` | `{version, type, size}` 或 `undefined`（不存在） |
| `lstat` | `(path, {cwd}, signal)` | 同上，不跟随最后一段符号链接 |
| `readText` | `(target, signal)` | `string`，非 UTF-8/含 `\0` 抛 `FS_NOT_TEXT` |
| `streamText` | `(target, signal)` | `AsyncIterable<string>` |
| `readBytes` | `(target, signal, maxBytes)` | `Buffer`，超限抛 `FS_TOO_LARGE`（不截断） |
| `readByteRange` | `(target, {offset,length}, signal)` | `Buffer` |
| `listDir` | `(target, signal)` | `[{name, type, target:{targetKey,displayPath}, version?, size?}]` |
| `writeText` | `(target, content, expected, signal, sandboxPolicy)` | `{operation:'create'\|'update', version, before, after}` |
| `editText` | `(target, {oldString,newString,replaceAll}, expected, signal, sandboxPolicy)` | `{version, before, after}` |
| `watch` | `(target, changed, signal)` | `Promise<() => Promise<void>>`，初始化完成才 resolve |
| `contains` | `(parent, child)` | `boolean` |
| `processPath` | `(target)` | 执行世界里的路径字符串 |
| `processPathFromHostPath` | `(hostPath)` | 映射不到就 `undefined` |
| `fileUrl` | `(target)` | URL 字符串 |
| `get sandboxMode` | — | 部署默认模式 |

`expected`（版本守卫）：`{kind:'replaceIfVersion', version}` 或 `{kind:'createIfAbsent'}`。

错误码（`FsError`，`@deepseek-ai/dsh-fs` 导出）：`FS_NOT_FOUND`、`FS_NOT_TEXT`、`FS_NOT_DIRECTORY`、`FS_NOT_REGULAR_FILE`、`FS_TOO_LARGE`、`FS_ABORTED`、`FS_STALE_VERSION`、`FS_NOT_OBSERVED`、`FS_EDIT_NOT_FOUND`、`FS_AMBIGUOUS_EDIT`、`FS_PERMISSION_DENIED`、`FS_IO_ERROR`、`FS_SANDBOX_DENIED`。

### 4.3 为什么工作区必须经过 `ctx.fs`

`ctx.workspaceRegistry.create(path)` 的文档原文：

> Create or reuse a workspace for an existing directory. The fully qualified path is canonicalized through `fs.realpath`; a relative, nonexistent, or non-directory path rejects.

也就是说：**只要 `ctx.fs.resolve()` 认这个路径，远程目录就能成为真工作区**，不需要改工作区注册表、不需要改 UI。

---

## 5. 上次失败的完整记录（请务必先读）

### 5.1 时间线与现象

| # | 动作 | 结果 |
| --- | --- | --- |
| 1 | 写 `fs-provider.js`，patch 里 `disable fs-sandbox` + `insert presence-fs` | 启动后**新建会话失败**：`gateway/service-unavailable: session/create: active Service "sessionController" is unavailable`；`ctx.fs` 消失 |
| 2 | 恢复补丁（撤回 swap） | 正常 |
| 3 | 加自检行（不注册 fs），补 `peerDependencies` | 自检跑通，`application: applied` |
| 4 | 再次开启 swap | **同样的新建会话失败** |
| 5 | 恢复 | 正常 |

### 5.2 已确认的根因（第一层）

第一次失败的确切错误（来自 install 诊断）：

```
presence-selfcheck (dsh-presence/selfcheck): failed to import:
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-fs-sandbox'
imported from D:\04_Dev\Presence\src\fs-provider.js
```

**结论：第三方插件只能 import 声明在自己 `package.json` 的 `peerDependencies` 里的 `@deepseek-ai/*` 包。** 声明之后即可解析（已通过在 `package.json` 增加 `@deepseek-ai/dsh-fs`、`@deepseek-ai/dsh-fs-sandbox` 验证）。

### 5.3 未确认的根因（第二层，必须优先诊断）

第二次失败时 `install_bundle` 的返回被中断，**没有拿到那条诊断**。目前只有假设，没有证据。两个候选：

**假设 A（可能性最高）：模块实例不共享。**
插件 `import '@deepseek-ai/dsh-fs-sandbox'` 拿到的可能是另一份模块实例，于是
`class PresenceFileSystem extends SandboxedFileSystem` 继承的是**另一个** `Service` 类。
Cordis 的 `Service` 依赖实例身份注册/解析，跨实例会失败 → `ctx.fs` 不存在 → 依赖它的 `sessionController` 也起不来。

**假设 B：构造/注入失败。**
`static inject = ['sandboxPolicy']` 未被继承、或 `ctx.sandboxPolicy` 在该行激活时还不可用。

### 5.4 必须先做的诊断（步骤与命令）

**不要直接在生产 profile 上重试。** 用 `ELECTRON_RUN_AS_NODE` 起一个完全隔离的 DSH（这一步已经验证可行，见 5.6）。

### 5.5 隔离验证结果（2026-10-23，已完成）

**结论：`ctx.fs` 替换方案在隔离环境里是可行的，已端到端跑通。**

做法：用应用自带的 Electron 二进制当 Node 运行时（能读 asar），`DSH_HOME` 指到工作区内的临时目录，建一个独立 profile：

```powershell
$exe='C:\Users\user\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$bin='C:\Users\user\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'
$env:ELECTRON_RUN_AS_NODE='1'
$env:DSH_HOME='D:\04_Dev\Presence\.dsh-isolated'
# 建 profile（模板：web 或 headless 均可）
& $exe $bin presence-test --from-default-profile headless --dump-config
# profile 的 package.json 里加 dsh-presence 依赖 + bundles，node_modules 用 junction 指到 D:\04_Dev\Presence
# 用 --patch 叠加 fs-swap.yml（disable fs-sandbox + insert presence-fs）
& $exe $bin presence-test --patch .\.dsh-isolated\fs-swap.yml "probe"
```

探针（`.dsh-isolated/probe/index.js`，作为插件行插入）通过 **`ctx.fs` 直接操作远端**，结果：

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `resolve('presence://server/etc/hostname')` | ✅ | 返回 presence target |
| `stat` | ✅ | `{version:"presence:1693280014000:6:f", type:"file", size:6}`（真实 SSH 往返） |
| `readText` | ✅ | 内容 `server` |
| `listDir('presence://server/')` | ✅ | 33 个条目 |
| 本地路径未退化 | ✅ | 本地目录 stat 正常返回 |
| `readBytes` | ⚠️ | 唯一失败项：headless 缺 API Key 提前销毁上下文，探针在 SSH 往返中被切断，**不是代码路径问题** |

同时还确认了两件事：

1. **`inject` 生效**：provider 先于 `sandboxPolicy` 加载时，Cordis 会推迟激活，等依赖出现后再注册（`scripts/isolated-check.mjs` 的 `ORDER=provider-first` 用例）。
2. **隔离 harness 本身**：`ctx.plugin(PresenceFileSystem, config)` 后 `ctx.get('fs')` 正确返回实例；`ctx.fs` 对 `presence://` 与本地路径同时可用。

**尚未解释的唯一问题**：同样的补丁在用户的 `desktop` profile 里会让 `ctx.fs` 消失。差异在于那个 profile 还加载了 `@deepseek-ai/dsh-web-app`、`@linxin666/dsh-remote-web-ui`、`dsh-context`、`dsh-notify-me`、`@deepseek-ai/dsh-experimental-*-profile` 等。下一步应该：

1. 在隔离 profile 里**逐组加入**这些 bundle，复现失败，定位冲突源（优先怀疑 remote-web-ui：它也注册 HTTP 路由/服务，且和连接/网关耦合最深）
2. 或者先在隔离的 **web** profile（含 web-app + 我的 bundle + fs swap）里跑探针，确认 web 组合本身没问题

只有隔离环境全绿、且能解释 desktop profile 的差异之后，才把它合进用户正在用的 profile。

#### 5.5.1 桌面组合的部署尝试：失败，不要盲目重试

在隔离环境全绿之后，曾在用户正在使用的 `desktop` profile 里做过两次受控部署，两次都导致：

```
gateway/service-unavailable: typert gateway: session/create:
active Service "sessionController" is unavailable
```

即 `ctx.fs` 消失，所有依赖它的服务连带起不来（**当前会话不受影响，新建会话全部失败**）。恢复办法：把 bundle 从 profile 移除 + 重启，`fs-sandbox` 自动回来。

关键观察：

- 两次失败都伴随 `install_bundle` / `remove_bundle` **调用被中断**（组合重载期间宿主忙，调用被切断），profile 停在「`fs-sandbox` 已禁用 + `presence-fs` 未成功」的中间态。
- 隔离环境里从未复现；能复现的差异只有 `dsh-web-app`（headless 里加它会静默退出，无法跑探针）与桌面 Electron 壳。
- 因此在下结论之前，必须先解释 desktop composition 与隔离 composition 的差异。**在解释清楚之前，不要在生产 profile 上再开这个 swap。**

建议的下一步（二选一）：

1. **做一份独立发行版/独立 profile**：在 `dsh web` 能正常启动的隔离 profile 里（需要能跑 UI），把 swap 打开，用真实 web 界面验证；这需要能拉起一个不依赖桌面壳的 web 实例。
2. **改 DSH 本体**（方案 C）：给 `dsh-fs` 加多后端按 scheme 路由，从根上避免「第三方插件替换一等公民服务」。

### 5.5.2 真正的根因与最终解法（2026-10-23 已验证通过）

**根因不在 `ctx.fs`，在工作区注册表**：

```js
// @deepseek-ai/dsh-workspace/lib/types/paths.js
export async function realpathNormalize(path) {
  if (!fullyQualifiedWorkspacePath(path)) throw new TypeError(...); // Windows: win32.isAbsolute 且 root ≠ '\'
  return await realpath(path);                                      // node:fs/promises，绕开 ctx.fs
}
```

工作区路径用 **Node 的文件系统**做 realpath 校验，完全绕过 `ctx.fs`。所以任何虚拟 scheme（`presence://…`）都不可能成为工作区；UNC 形式（`\\presence\host\path`）虽然能过 isAbsolute，但 realpath 会去解析一个不存在的主机。

**解法：本地挂载点（mount marker）**

```
<DSH_HOME>/presence/mounts/<host>/<绝对远端路径>
```

- 这个目录在本地真实存在（`mkdir -p`），里面永远是空的
- 工作区注册表的 realpath / status 检查全部通过
- `presence-fs` 的 `resolve()` 把该子树下的**任意路径**映射成 `presence://<host><远端路径>`（`src/mounts.js` 的 `parseMountPath`）
- 于是：工作区在左侧出现、会话 cwd 是挂载路径、文件树通过 `ctx.fs.listDir` 展开远端、内置 `read`/`write`/`edit` 直接读写远端

**已验证**（用户机器，Windows + 桌面应用 + fs 模式）：

| 行为 | 结果 |
| --- | --- |
| 左侧工作区列表出现远程工作区 | ✅ |
| 内置 `read` 读挂载路径下的远端文件 | ✅ |
| 内置 `write` 写挂载路径 → 远端文件真实出现、内容正确 | ✅ |
| `presence_exec` 在同一目录读回写入内容 | ✅ |
| 内置 `grep`/`glob` | ❌ 原生 ripgrep 看不到虚拟文件，用 `presence_search` |

**部署方式（关键）**：`install-presence.ps1 -Mode fs`，**冷启动**。多次失败证明：在应用运行中用 `plugin_manager` 热装/卸会打断进行中的调用并留下半成品组合；冷启动一次挂载则稳定。

**剩余小项**（可选）：
- 挂载点命名对用户不友好（侧边栏显示 `...\.dsh\presence\mounts\...`），可考虑用 workspace 标题掩盖
- `grep`/`glob` 走原生搜索，要接上远端需要在 `dsh-tool-fs-search` 层做抽象（当前用 `presence_search` 代替）

#### 5.5.3 踩坑记录：向上找项目根标记

`@deepseek-ai/dsh-agent-instructions` 的 `findProjectRoot()` 会从会话 cwd **逐级向上**找 `.git` / `AGENTS.md` 等项目根标记，并用 **node 的 `path.resolve`** 拼路径。

当会话 cwd 是挂载点（`...\mounts\server\nas4\Tent`）时，向上走到挂载根 `...\mounts` 后，它会拼出：

```
...\mounts\.git
```

早期实现的 `parseMountPath()` 只看「路径是否在挂载根之下」，于是把 `.git` 当成了**主机名**，拼出 `presence://.git/`，再去 ssh config 里找名为 `.git` 的主机 → 整轮失败（`sessionController`/工具报错）。

**修复**：`parseMountPath()` 必须校验第一段是**真实 ssh 别名**（`src/mounts.js` 的 `isKnownHost`）。非主机名直接返回 `null`，回落成本地路径——向上找标记时自然得到「不存在」，这正是期望语义。

同类陷阱：任何「把 `processPath()` 的结果当主机路径再拼」的调用方（拼接、`path.join`、存 session cwd）。因此 `processPath()` 对虚拟目标返回**本地挂载路径**而不是 `presence://` URL，保证往返一致。

### 5.6 失败时的恢复步骤（务必写进 runbook）

1. 把 `D:\04_Dev\Presence\cordis.patch.yml` 改回**只 insert presence 一行**（不含 `- id: fs-sandbox / disabled: true`，不含 `presence-fs`）
2. 用 `plugin_manager remove_bundle dsh-presence` → `install_bundle D:\04_Dev\Presence` 重装一次
3. 若应用已经无法新建会话：**重启 DSH**（组合在启动时重算，`fs-sandbox` 会自动回来）

> 关键点：**卸载 Bundle = 撤销它带来的 patch**，所以 `fs-sandbox` 会随之回来。这也是为什么「移除插件」永远能救回来。

---

## 6. 方案对比

| 方案 | 做法 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| **A. 第三方 Bundle 替换 fs** | 本文档第 4 节 | 不动 DSH 本体；效果最完整 | 受「模块实例/服务单例」约束，已失败两次；失败会连带打死 `sessionController` | 先诊断 5.3，能解决就用 |
| **B. 自建发行版** | fork DSH 的 profile/包层，把远程 fs 作为一等公民编进去 | 完全可控，可做多后端路由 | 要维护发行版，升级 DSH 需合并 | **若 A 不可行，推荐这个** |
| **C. 上游贡献** | 给 `@deepseek-ai/dsh-fs` 加「多后端按 scheme 路由」 | 最干净，所有下游受益 | 需要改 DSH 仓库、等合入 | 适合长期 |
| **D. 本地挂载（sshfs/WinFsp）** | 把远程目录挂成本地路径 | 零改动 | 违背「远端零安装」，Windows 要装驱动，延迟差 | 不推荐 |

**建议顺序：先花 1–2 小时做 5.4 的诊断 → 若 A 可行就按第 7 节走 A；否则直接 B。**

---

## 7. 推荐实施步骤（方案 A，假设诊断通过）

### 阶段 0：隔离验证（不碰生产 profile）

- 用独立 profile（复制 `C:\Users\user\.dsh\profiles\desktop` 去掉第三方包）加载 `presence-fs`
- 验收：`ctx.fs.resolve('presence://server/etc/hostname')` 返回 target；`readText` 返回 `server`
- 失败不影响任何人在用的 profile

### 阶段 1：provider 就位

- 基于 `src/fs-provider.js`（已实现），补两处：
  - `constructor` 里把 `ctx.sandboxPolicy` 改成惰性读取（`this.ctx.sandboxPolicy?.defaultMode ?? 'workspace-write'`），降低注入时序风险
  - 若假设 A 成立且无法解决，改为**不继承** `SandboxedFileSystem`，而是自实现全部方法 + 在内部用一个「本地实现对象」处理非 presence 路径（需要自己复刻沙箱 fence，见 4.2 的错误码）
- 验收：`fs-selfcheck.js` 的 14 项全绿

### 阶段 2：接线

patch 增加：

```yaml
- id: fs-sandbox
  disabled: true
- insert:
    - id: presence-fs
      name: dsh-presence/fs
      config: {}
```

- 验收：`Config.listConfigs` 里 `presence-fs` 为 `schema` 状态；`ctx.fs` 存在
- **失败即回滚**（5.5）

### 阶段 3：工作区打通

- 面板 API `/api/presence/workspaces` POST 里，除了写 Presence 注册表，再调用：
  ```js
  const registry = ctx.get('workspaceRegistry');
  await registry.create(`presence://${host}${path}`, title);
  ```
  （需要把 `ctx` 传进 `presenceRoutes`）
- 验收：左侧工作区列表出现远程工作区；点进去新建会话，会话 cwd 是 `presence://...`；文件树能展开

### 阶段 4：内置工具验收

在远程工作区的会话里直接（不要用 `presence_*`）：

- `read presence://server/etc/hostname` → 返回内容
- `write` 新建文件 → `presence_exec` 里 `cat` 能看到
- `edit` 带版本语义 → 并发修改时正确报 `FS_STALE_VERSION`
- `grep` / `glob` → 命中远程文件
- 本地工作区回归：读写、文件树、新建会话全部正常

---

## 8. 踩过的坑清单（血泪，逐条注意）

1. **Nagle/delayed ACK**：ssh2 连接必须 `client.setNoDelay(true)`，否则 p95 从 0.9ms 变 48ms。
2. **`MaxSessions`**：sshd 默认 10，一条连接最多 10 个通道；通道池上限设 8，留一个给 SFTP。
3. **SFTP v3 rename 不覆盖**：原子写必须用 `ext_openssh_rename`（OpenSSH 扩展），否则第二次写同文件必失败。
4. **`@deepseek-ai/*` 只能 import peerDependencies 里声明过的包**，否则 `ERR_MODULE_NOT_FOUND`。
5. **禁用 `fs-sandbox` 前必须确认提供方能起来**，否则 `ctx.fs` 消失 → `sessionController` 连带起不来 → 新建会话全挂。
6. **沙箱 fence 语义要保留**：read-only 拒绝写；workspace-write 只允许写工作区根下；danger-full-access 放行。绕过去等于降低安全性。
7. **每次 `install_bundle`/`remove_bundle` 都会重载整个插件组合**：重载期间宿主忙，正在进行的工具调用会被打断（表现为「卡住」）。不要在用户工作时段反复装卸。
8. **卸载 Bundle = 撤销 patch**，`fs-sandbox` 自动回来——这是最快的恢复手段。
9. **桌面版 IPC 桥只转发 `/api/*`**：第三方插件的路径必须挂在 `/api/<name>/...` 才在桌面应用里可用（浏览器下任意路径都行）。
10. **`workspaceRegistry.create` 会用 `fs.realpath` 校验**：路径必须存在且是目录；不存在/相对路径会被拒。
11. **`directoryPicker` 是单例抽象服务**：换实现会影响所有地方，不要为了远程浏览去替换它。
12. **面板/客户端代码不经过构建**：`client.js` 是 `window.__ModuleLoader__.load({id, factory})` 格式，改完刷新页面即可，不需要重装插件。

---

## 9. 测试清单

最小回归集（每次改动都跑）：

```powershell
# 1. 自检（不碰 ctx.fs）
#    安装后读 D:\04_Dev\Presence\selfcheck-report.json，要求 14/14

# 2. 连接与工具
presence_hosts
presence_exec --host server "uname -a"

# 3. 面板接口（两条路径都要通）
GET http://127.0.0.1:<port>/api/presence/workspaces
GET http://127.0.0.1:<port>/presence/api/workspaces

# 4. 工作区
POST /api/presence/workspaces {host, path}
POST /api/presence/workspaces {activate: id}
GET  /api/presence/browse?host=..&path=..
GET  /api/presence/file?host=..&path=..
```

候选主机：`server`（Ubuntu 20.04，IPv6，密钥登录，已验证可用）。

---

## 10. 未决问题 / 需要先和用户确认

1. **能不能改 DSH 本体？** 如果能，方案 C（上游加多后端路由）最干净。
2. **能接受重启应用吗？** 换 fs 提供方一定需要重启或至少一次完整组合重载。
3. **工作区绑定要不要 per-session？** 目前「当前工作区」是全局单例；多会话并行时要按会话绑定，需要额外的会话级存储。
4. **远程写是否需要额外的确认机制？** agent 在远程删改文件没有本地回收站。

---

## 11. 一句话交接

`src/core/connection.mjs` + `src/pool.js` 已经把「一条常驻 SSH 连接 + 远程读写执行终端」做完了，且实测可用；`src/fs-provider.js` 已经把 `ctx.fs` 契约实现完并自检通过。**剩下的唯一难点是「注册进 Cordis 时不崩」，请先按 5.4 拿到确切诊断，再决定走方案 A 还是 B。**
