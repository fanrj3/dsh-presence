# Presence

让 coding agent 在多台服务器上「像在当地一样工作」。

不改远端、不装东西、不配环境：从你已有的 `~/.ssh/config` 里挑一台机器，连上之后，
读写、搜索、执行、开终端都走同一条常驻连接，操作感受和本地文件系统一致。

---

## 为什么不是「agent 跑在远端」

| 方案 | 问题 |
| --- | --- |
| 每台服务器装 agent | 装 N 次、升级 N 次；要代理的机器还要逐台配代理 |
| agent 本机执行 `ssh host ...` | 每条命令一次握手；远端原生工具用不上；上下文不连续 |
| **Presence** | agent 留在本机（一套模型/代理/配置），能力通过一条常驻连接伸到远端 |

## 设计原则

1. **远端零安装**：只用 sshd 自带能力（SFTP 子系统、exec、shell/PTY），远端不落任何文件、不改任何配置。
2. **一次握手**：每台机器一条常驻 SSH 连接，之后所有操作都是这条连接上的请求，不再重连。
3. **用目标机的原生工具**：搜索交给目标机的 `rg`/`grep`，命令在目标机的 shell 里跑，路径语义、权限、编码都是本地的。
4. **像本地一样**：结构化返回（退出码、stdout/stderr 分开、超时、取消），文件写入是原子替换，编辑冲突会明确报错而不是猜。

## 架构

```
┌──────────────────────────────┐
│ DSH 插件（现在） / MCP（以后）│  同一内核，两种外壳
└──────────────┬───────────────┘
               │
        Presence 内核
        ├── ssh-config  从 ~/.ssh/config 读出主机、端口、用户、密钥、跳板
        ├── connection  一条常驻连接：SFTP / exec / PTY，通道池 + 取消 + 超时
        └── host pool   每台机器一条连接，按需建立、闲置回收
               │
        SSH（沿用你已有的密钥、known_hosts、跳板、代理）
               │
        目标机：Linux / macOS，sshd 自带能力即可
```

映射关系：

| Agent 的操作 | 走的通道 | 远端依赖 |
| --- | --- | --- |
| 读 / 写 / 编辑 / 列目录 / stat | SFTP 子系统 | sshd 内置 `sftp-server` |
| 执行命令、搜索（rg/grep）、git | exec channel | 目标机已有的命令 |
| 交互式终端 | shell channel + PTY | 目标机的登录 shell |

## 实测（server，Ubuntu 20.04，IPv6 校园网）

| 操作 | 耗时 |
| --- | --- |
| 传统 `ssh host <cmd>`，每次新连接 | 520 – 540 ms |
| Presence 建连（一次握手，含密钥认证） | 145 ms |
| Presence `sftp stat` | p50 0.6 ms / p95 0.9 ms |
| Presence `exec true`（新通道 + 起 shell） | p50 7.6 ms |
| 8 个 exec 通道并发 | 合计 15 ms |
| 50 个 sftp 请求流水线并发 | 合计 3 – 13 ms |

即：把「每条命令一次握手」换成「一次握手 + 每次 0.6 ms」。

> 关键细节：必须开 TCP_NODELAY。不关 Nagle，请求/响应会撞上 delayed ACK，p95 从 0.9 ms 劣化到 48 ms。

## 在 DSH 里使用

仓库根目录本身就是一个 Bundle（`dsh.bundle.patch` 指向 `cordis.patch.yml`），安装：

```
plugin_manager { action: "install_bundle", target: "D:\\04_Dev\\Presence" }
```

装好后模型可见这些工具：

| 工具 | 作用 |
| --- | --- |
| `presence_hosts` | 列出 ssh config 里的机器与当前连接状态 |
| `presence_connect` | 建立常驻连接并报告远端身份 |
| `presence_exec` | 在远端执行命令；默认 `pipefail`，支持 `background:true`、`waitForPort`、`timeoutMs`（超时会真杀进程树）；输出默认去 ANSI、首尾截断 16KiB（`maxOutput`/`raw` 可调），全量落盘并给路径；**危险命令先 dry-run，需 `confirm:true`** |
| `presence_trash` | **可恢复删除**：把路径移入远端 `~/.dsh/presence-trash/<时间戳>/`，返回恢复路径；`action:'trash'|'list'|'restore'` |
| `presence_jobs` | `list`（默认只看本会话）/ `wait`（返回退出码 + 末尾日志，替代 sleep+tail）/ `stop`（按 jobId 或 pgid） |
| `presence_read` | 读远端文件，带行号与 offset/limit；大文件走远端窗口读取（行数真实）；二进制明确拒绝；读完会给 harness 记账，内置 `edit` 可直接用 |
| `presence_write` | 原子整体写入，自动创建父目录；**保留原文件 mode**，可用 `mode:"755"` 显式指定 |
| `presence_edit` | 精确文本替换（`old`/`new` 与 `replace_all` 别名都认），锚点不唯一就报错，保留 mode |
| `presence_search` | 远端 rg 搜索；`countOnly` 只返回数量，超限返回 `truncated`/总数，路径不存在或正则非法直接报错 |
| `presence_glob` | 远端按 glob 找文件（支持绝对 pattern，返回 size/mtime，按新→旧排序） |
| `presence_export` | 远端 → 本地真实文件（内容寻址去重、自动清理、返回 sha256），供 `present` / Explorer / Office 使用 |
| `presence_import` | **本地 → 远端**（截图、附件、构建产物等），二进制安全、可设 mode、返回 sha256；上限 64 MiB |
| `presence_forward` | 本地端口转发到远端端口（建立前预检端口）；`http://127.0.0.1:<port>` 访问远端服务 |
| `presence_terminal` | open / write / read / close 持久终端；带 `session` 时用 tmux，断线可重连；`close {killSession}` 彻底结束 |

> 远程会话里内置 `grep`/`glob` 由插件**接管并转发到远端**（路径、大小写、截断规则与 `presence_search` 一致），不再出现"扫本地盘、静默空"的情况。

**本地 ↔ 远程文件通道**：
- 本地 → 远程：`presence_import {source: "C:\\Users\\...\\attachments\\...\\a.png", to: "docs/a.png"}`
- 远程 → 本地：`presence_export {path: "docs/a.png"}` → 返回本机真实路径（再 `present` 才能被 GUI/预览看到）

### 危险命令护栏（防误删）

`presence_exec` 识别到 `rm -r/-f`、`git clean -fdx`、`find -delete`、`shred`、`truncate`、`dd of=/dev/...` 时**不会直接执行**：

1. 在"只报告不删除"的 shell 里重跑一遍（`rm` 被函数遮蔽、`find -delete` 换成 `-print`、`git clean` 加 `-n`），拿到**展开后的绝对目标**
2. 无变量未定义检查：命令里出现未设置的 `$VAR` 直接拒绝（这正是那次 `.tmesh` 被删的原因）
3. 无条件拒绝：工作区根目录、工作区根的任何祖先、家目录、`/`、`.git` 元数据
4. 其余情况返回报告（目标类型 / 文件数 / 体积），**要执行必须再调一次并带 `confirm:true`**

```
presence_exec {command: "rm -rf .tmesh/$J"}
→ destructive command needs confirmation (rm) — nothing was executed yet
  resolved targets:
    dir  /srv/app/TensorMesh/.tmesh  128 files  42.1 MB
  Pass confirm:true to execute it. Prefer presence_trash ...
```

工作区里要删东西，优先 `presence_trash {action:'trash', path:'build'}`：它是"移动到回收站 + 返回恢复路径"，零安装（就是远端 `mv`），后悔了 `action:'restore'` 放回去。

**长任务推荐姿势**：`presence_exec {command, background:true}` → 拿到 jobId → `presence_jobs {action:'wait', jobId}` 等它结束（返回退出码和末尾日志）→ 需要时 `presence_jobs {action:'stop'}`。

配置项（写在 `cordis.patch.yml` 的 `config` 里，会被你的补丁层覆盖）：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `maxChannels` | 8 | 每连接并发通道数（sshd `MaxSessions` 默认 10，留一个给 SFTP） |
| `connectTimeoutMs` | 25000 | 单次连接尝试上限 |
| `idleTimeoutMs` | 900000 | 空闲多久断开；仍持有终端的连接不会被回收 |
| `readOnly` | false | 拒绝写入与编辑，读取/搜索/执行不受影响 |

### 工作区（这是使用入口）

面板：**设置 → Presence**

1. 「新建」→ 选一台机器（要密码的当场输入，可勾「记住这台」）
2. 连接后进入**远程目录浏览器**：机器徽标 + 路径面包屑 + 条目计数；文件夹/文件分开排序，文件显示大小，条目多的目录自动出现筛选框
3. 「用这个文件夹」→ 生成一个远程工作区
4. 工作区按**机器分组**：每台机器一行（绿点 = 这台机器当前已连接），下面挂它的文件夹；可「浏览文件」（进入子目录、点文件在下方预览）「移除」

> 不再有「设为当前」：每个会话以自己的 cwd 决定用哪台机器/哪个根，左侧每个远程工作区打开就能用。

**改远端文件请用 `edit` / `write` / `presence_edit` / `presence_write`**，不要用 `sed -i`、`perl -pi` 或 shell 重定向——前者是原子写、有歧义拒绝和版本守卫，后者会绕过这些保护。

会话在某个远程工作区里时，**agent 的工具不再需要 host**：

| 调用 | 行为 |
| --- | --- |
| `presence_exec(command)` | 在那台机器的那个工作区根目录下执行 |
| `presence_read('src/app.ts')` | 解析成 `<工作区根>/src/app.ts` |
| `presence_write` / `presence_edit` / `presence_search` / `presence_glob` | 同上，相对路径都相对工作区根 |
| 绝对路径 / `~/路径` / `presence://host/path` / 本地挂载路径 | 全部等价可用；跨主机路径会明确报错 |

每个模型步骤都会注入一行运行时上下文，说明当前会话是不是远程工作区、能用哪些工具。

### 路径与权限矩阵（容易踩坑的地方）

| 操作 | 相对路径 | 远端绝对 `/srv/...` | `presence://host/path` | 本地挂载 `C:\...\mounts\...` |
| --- | --- | --- | --- | --- |
| 内置 `read`/`write`/`edit` | ✅ | ✅ | ✅ | ✅ |
| 内置 `grep`/`glob` | ✅ | ✅ | ✅ | ✅（插件转发到远端） |
| 内置 `read_image` | ✅ | ✅ | ✅ | ✅（走 ctx.fs.readBytes，不需要先导出） |
| `presence_*` 工具 | ✅ | ✅ | ✅ | ✅ |
| `present` | 卡片预览 ✅ | — | — | 卡片预览 ✅ / **原生打开 ❌** |
| Office / Python 等宿主程序 | 仅本地文件 | — | — | **❌ 需先 `presence_export`** |

**工具远程能力一览**（哪些不用换写法）：
- **自动远程**：`read`/`write`/`edit`（走挂载路径）、`grep`/`glob`（插件拦截转发）、`read_image`（走 ctx.fs 读字节，需 image-capable 模型）、`presence_*` 全套
- **需要显式转换**：`present` 的原生打开、Office/Python 等宿主程序 → 先 `presence_export`，需要反向则 `presence_import`
- **只看本地**：宿主 `glob`/`grep` 之外的本地命令、`pwsh`

权限：
- **ctx.fs 的写入范围 = 会话自己的工作区**（DSH `workspace-write` 策略）。工作区外（例如工作区是 `/srv/app`、你要写 `/srv/workspace`）会被 DSH 沙箱拒绝 —— 这是**策略限制，不是远端权限**；用 `presence_write` / `presence_exec` 就能写。
- 远端 `/tmp` 同理：`ctx.fs` 不写远端 `/tmp`，用 `presence_write` / `presence_exec`。
- 写入路径会做**远端 realpath 校验**：工作区里的符号链接指向工作区外时，写入会被拒绝（防沙箱逃逸）。
- 覆盖写会**保留原文件 mode**（可执行文件不会因为 `edit` 变成 644）；新文件默认 644，可用 `presence_write {mode}` / `presence_import {mode}` 指定。
- `present` 只记录路径：远程文件在应用内**预览可用**，但「原生打开」按钮不行；要在外部程序打开，先 `presence_export` 成真实本地文件再 `present`。

工作区记录在 `~/.dsh/presence/workspaces.json`；同一 (机器, 目录) 只会有一条。

### 真正的 DSH 工作区（本地挂载点）

远程文件夹会以**本地挂载点**的形式注册成真正的 DSH 工作区：

```
C:\Users\<你>\.dsh\presence\mounts\<主机>\<远端绝对路径>
```

这个本地目录是**空的占位**，只为通过工作区注册表用 `node:fs/realpath` 做的「必须是真实目录」校验。Presence 的文件系统提供方把该目录下**所有路径**映射回远端，所以：

| 行为 | 状态 |
| --- | --- |
| 左侧「工作区」列表出现该远程工作区 | ✅ |
| 在它里面新建会话，cwd 是远程路径 | ✅ |
| 文件树展开远程目录 | ✅ |
| 内置 `read` / `write` / `edit` | ✅ 直接读写远端 |
| 内置 `grep` / `glob` | ✅ 插件拦截并转发到远端（不是扫本地盘） |
| `presence_exec` / `presence_terminal` | ✅ 在远端执行 |

### 认证

- **密钥**：ssh-agent → `IdentityFile` → 默认密钥（`id_ed25519`、`id_rsa`），按顺序尝试，失败原因归一化成人话。
- **密码**：默认**只存在进程内存**，不落盘、不进会话日志。面板就绪前，可以用环境变量
  `PRESENCE_PASSWORD_<ALIAS>`（别名大写、非字母数字换成下划线）提供，例如 `PRESENCE_PASSWORD_SERVER_V6`。
- **「记住这台」**：面板里的开关，默认关闭；打开后密码交给 DSH 的凭据服务保管（落盘方式由该服务决定），重启免输。

### 面板终端 = 远程 shell

DSH 右侧的终端面板原本只会起**本机** shell，cwd 被设成挂载路径（空壳目录）。Presence 把 `terminal-controller` 的默认 shell 换成了一个 launcher（`scripts/presence-shell.ps1`，以 `-EncodedCommand` 内嵌在 `cordis.patch.yml` 里）：

| 打开终端的会话 | 实际启动 |
| --- | --- |
| 远程工作区（cwd 在 `~/.dsh/presence/mounts/<host>/...` 下） | `ssh -t <host> "cd '<远端目录>' && exec $SHELL -l"` —— 就是那台机器、那个目录 |
| 本地工作区 / 其它 cwd | 本机 `cmd.exe`，与原生行为一致 |

所以：**在远程工作区点「新终端」，直接看到远端目录的提示符**；`git`、`tmux`、补全、颜色都走远端环境，远端仍然零安装（只用 ssh 客户端）。

- launcher 源码在 `scripts/presence-shell.ps1`；改完运行 `node scripts/embed-shell.mjs` 重新内嵌（打包脚本会做 `--check`，stale 直接失败）
- 想恢复原生行为：删掉 `cordis.patch.yml` 里 `# >>> presence-shell ... <<<` 那一段，重启
- 需要密码的机器：ssh 会在终端里提示输入；密钥/ssh-agent 的机器无感
- 终端窗口关掉 = ssh 断开；需要跨断线的持久 shell 用 agent 的 `presence_terminal {session}`（远端 tmux）

### 侧边栏文件浏览器（XFTP 风格）

右侧栏「开始」页多了一项 **远程文件**：一个远程目录面板，可以像 Xftp 一样传文件。

| 操作 | 行为 |
| --- | --- |
| 拖本地**文件**到列表 / `＋ 文件` | 上传到当前远端目录，底部显示百分比进度 |
| 拖本地**文件夹**到列表 / `＋ 文件夹` | 按原目录结构递归 `mkdir` + 逐文件上传（有进度） |
| 双击图片 | 弹窗预览（走 `/raw` 直出字节） |
| 双击文本 / 代码 | 弹窗预览前 256 KiB：**行号 + 语法高亮**（注释/字符串/数字/关键字/函数调用着色），等宽字体 |
| 双击其它类型（或预览失败） | 调起系统「另存为」对话框（File System Access API；不可用时回退浏览器下载） |
| 行尾 `↓` 文件 | 保存单个文件到本地 |
| 行尾 `↓` 文件夹 | 选一个本地目标文件夹 → **递归下载成真实目录树**（Xftp 的"下载文件夹"），底部有进度 |
| 行尾 `🗑` | 移到**远端回收站**（可恢复，见 `presence_trash`） |
| `新建` / `⟳` / 筛选框 | 新建文件夹 / 刷新 / 过滤当前目录 |
| 顶栏下拉 | 切换机器（默认跟随当前会话的工作区，没有则用第一个工作区） |
| 需要密码的机器 | 自动弹**密码对话框**（密码 / 「记住这台」/ 取消），连上后继续浏览当前目录 |
| 取消「选择目标文件夹」 | 视为取消，不报错 |

界面按 [OpenDesign](https://open-design.ai/zh/plugins/design-system-agentic/) 的规范实现，并**全部落在 harness 主题自己的 token 上**：4px 间距网格、圆角 4/8/12/pill（`--dsw-radius-*`）、`1px ring + 柔阴影`、动效 `100ms/300ms` + `cubic-bezier(.4,0,.2,1)`（`--ds-transition-duration-*` + `--ds-ease-in-out`）、交互底色 `--dsw-alias-interactive-bg-hover`、选中 `--dsw-alias-bg-multi-select`、强调 `--dsw-alias-state-business-primary`；图标为内置描边 SVG（不再用 emoji），行内文本禁止选中，工具栏/面包屑/操作按钮均为图标按钮。

**关于"拖出"的准确说法**：
- **文件可以拖出**到资源管理器：Chromium 的 `DownloadURL` 机制会把 URL 下载成临时文件再交给系统。
- **文件夹不能拖出**，这是 web 平台限制而不是没实现：`DownloadURL` 只能表达"一个文件"；拖出目录必须由 Electron 主进程调 `webContents.startDrag({ files: [目录] })`，而 DSH 的 host 是独立 Node 子进程（`app.asar/lib/main.js:3794` `spawn(node)`），主进程与 host 之间只有 `/api/*` 转发，没有拖拽通道。要真正支持需要 DSH 上游加一条 IPC。
- 等价的文件夹下载已实现（`↓` → 选目标目录 → 递归落地）。
- 从资源管理器往页面拖**文件和文件夹**都稳定可用，且面板会拦截这次拖放（`stopPropagation`），不会再把文件同时塞进右侧聊天框。

## 当前状态

- [x] 解析 `~/.ssh/config`（Host / HostName / Port / User / IdentityFile / Include / 全局默认 / 引号）
- [x] 密钥认证：ssh-agent、多密钥顺序尝试、失败原因归一化
- [x] SFTP 读 / 原子写 / 精确替换编辑 / 列目录 / stat / 二进制读取
- [x] exec：独立通道、超时、取消、退出码、stdout/stderr 分离
- [x] 通道池（受 sshd `MaxSessions` 约束）
- [x] PTY 终端，随连接存活
- [x] DSH Bundle：8 个工具，已装进 profile 并实测
- [x] 密码认证（进程内存 / 环境变量），已接入连接层
- [x] 设置页面板：服务器选择 → 远程目录浏览 → 创建远程工作区
- [x] 工作区作用域：设为当前后，工具不需要 host，相对路径相对工作区根，上下文自动切换
- [x] 面板内浏览工作区文件、预览内容
- [x] 面板 API：仅本机 + 同源防护，跨站请求返回 403
- [x] 每个模型步骤注入一行运行时上下文：工作区绑定（或机器总数 + 已连接清单）
- [x] 断线自愈：连接掉线后被标记失效，下一次调用自动重建，无需手动重连
- [ ] 密码登录的端到端实测（代码已就绪，暂无支持密码的目标机可测）
- [ ] ProxyJump / ProxyCommand
- [ ] 终端跨连接恢复（需要目标机已有 tmux 时复用）
- [ ] MCP server（内核无 DSH 依赖，抽出即可复用）

## 已知边界

- **挂载路径是虚拟的**：`~/.dsh/presence/mounts/...` 只对 `ctx.fs` 生效，Explorer / Office / 宿主 Python 看不到远程文件（见上面的能力矩阵）。
- **并发上限**：sshd 默认 `MaxSessions 10`，一条连接最多 10 个通道（已留一个给 SFTP，池子上限 8）。这是服务器策略，不是插件限制。
- **终端生命周期**：PTY 跟随连接存活；需要跨断线/重启时用 `presence_terminal {session}`，它在目标机复用 `tmux`（仍然零安装）。
- **SFTP 语义**：写文件用 `writeFile` + OpenSSH `posix-rename` 扩展做原子替换；没有该扩展的服务器退化为「删除后重命名」。覆盖写保留原文件 mode；新文件 644（受远端 umask 影响，可用 `mode` 指定）。
- **`present` 的原生打开**：卡片预览可用，但"原生打开"按钮要求宿主进程能映射该路径；虚拟挂载路径映射不了，需先 `presence_export`。
- **`read-before-write` 守卫**：只对内置 fs 工具生效；`presence_write` 绕开它，但会通过 `fs/observed` 事件给内置 `write`/`edit` 记账，所以两边可以混用。

## 开发与版本管理

源码在 git 里（`main` 分支，版本用 tag 标记，例如 `v0.7.1`）。仓库只跟踪源码：

```bash
npm install                       # 依赖只有 ssh2；node_modules 不进 git
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package.ps1 -Version 0.7.1
# → dist/presence-plugin-0.7.1.zip（内含 node_modules，可直接被 DSH 安装）
```

改动后至少跑这些验证（都需要一台可 ssh 的主机）：

```bash
node scripts/regression.mjs server   # 传输层：符号链接写、行数、超时、落盘、二进制
node scripts/job-probe.mjs server    # 后台任务 + 端口转发
node scripts/feature-probe.mjs server # wait/会话过滤/pgid/就绪/搜索语义
node scripts/import-probe.mjs server # 本地→远程二进制、mode、sha256
node scripts/safety-probe.mjs server # 危险命令护栏 + 观测状态存储
```

`scripts/isolated-check.mjs` 需要在 Electron-as-Node 下跑（路径矩阵 + 沙箱围栏），打包时不会带进 zip。

## 运行

```bash
node scripts/probe.mjs server
```

需要本机有 Node ≥ 22.19。`ssh2` 是唯一的运行时依赖。
