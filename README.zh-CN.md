<div align="center">

<img src="assets/icon-180.png" width="88" alt="Presence icon" />

# Presence

**把 SSH 机器变成本地标签页。**

给 coding agent 用的持久远程工作区、原生文件编辑、搜索、命令执行、终端和端口转发
—— **远端不需要安装任何东西**。

[English](README.md) · [简体中文](README.zh-CN.md) · [版本记录](docs/RELEASE.md) · [MCP server](mcp/README.md)

[![npm plugin](https://img.shields.io/npm/v/@rjfan/dsh-presence?label=dsh%20plugin&color=2f6bff)](https://www.npmjs.com/package/@rjfan/dsh-presence)
[![npm mcp](https://img.shields.io/npm/v/presence-mcp?label=presence-mcp&color=2f6bff)](https://www.npmjs.com/package/presence-mcp)
[![license](https://img.shields.io/badge/license-MIT-2f6bff)](LICENSE)
[![awesome-dsh-plugin](https://img.shields.io/badge/awesome--dsh--plugin-listing-2f6bff)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

</div>

![Presence — 远程机器就是本地标签页](docs/social/cover-light.png)

---

> ⚠️ **本地会话不会绑定远端工作区。** 在 Presence 里打开一个远程工作区，并不会把本地 agent
> 会话变成远端会话。当会话工作目录不在 presence 挂载根下时，`presence_exec` 及其他
> `presence_*` 工具必须显式传 `host`（或配置 `PRESENCE_HOST`）；否则会带着当前 cwd 报错，
> 而不是静默跑到上一次激活的机器上。在远程工作区内启动的会话则自动解析到该机器。
> 详见[已知边界](#已知边界)。

## 为什么不是「agent 跑在远端」

在每台服务器上装 agent，意味着装 N 次、升级 N 次、逐台配代理；让本地 agent 每次
`ssh host '<command>'`，意味着每条命令一次握手、用不上原生文件工具、上下文不连续。

Presence 让 agent 留在本机，**通过每台机器一条常驻 SSH 连接把能力伸到远端**。远端
仍然只是普通的 `sshd`：SFTP、exec 和一个 PTY。

| 方案 | 代价 |
| --- | --- |
| 每台机器装 agent | N 次安装、N 次升级、逐台代理配置 |
| 每个操作 `ssh host '<cmd>'` | 每条命令一次握手、无文件工具、无会话 |
| **Presence** | 每台机器一条连接、原生工具、远端零安装 |

## 特性

- **远端零安装** —— 只用 `sshd` 自带能力：SFTP 子系统、exec 通道和 PTY。
- **一次握手** —— 连接池为每台机器保持一条连接，之后的调用都是这条连接上的请求。
- **用目标机的原生工具** —— `rg`/`grep` 在目标机跑，命令在目标 shell 里执行；路径、权限、编码都是远端的语义。
- **接近本地的编辑** —— 原子写、保留 mode、锚点歧义拒绝、读后写守卫、`presence_edit` 的 dry-run diff。
- **真正的远程工作区** —— 远端目录注册成普通 DSH 工作区，文件树、终端都**开在远端机器上**。
- **会话有作用域（0.20 热修）** —— 本地会话不再静默借用上一次激活的远程工作区：`presence_*` 必须显式传 `host` 或配置 `PRESENCE_HOST`；系统提示会告诉每个会话自己是本地还是远程工作区。
- **条件等待，不用 sleep** —— `presence_wait` 等文件（`exists`/`minBytes`/`mtimeAfter`）、grep 命中数、进程（`pid`/`pattern`）、端口状态或任务 id；超时返回 `met:false`，不是错误。
- **任务跨重启存活** —— 后台任务持久化到 `~/.dsh/presence/jobs.json`，带 pid/pgid；`logPath` 是要 tail 的任务日志，`commandLogPath` 是命令自己的日志（当前内核里等于 `logPath`；只有内核提供独立包装日志时才不同），用 `commandLogPath ?? logPath`；重启后状态是 `unknown` 直到探活，不会假装 `running`，退出码可能缺失。
- **批量传输与追加写** —— `presence_import`/`presence_export` 支持 `paths[]`（1–50）或 glob，逐文件返回；`presence_write { mode:"append" }` 追加写。
- **可恢复的删除** —— 危险 shell 命令先 dry-run；`presence_trash` 移入远端回收站并可恢复。
- **`@` 能补全远端文件** —— 远程工作区里，文件引用补全直接索引目标机（`rg --files`，回退 `find`），不是本地镜像。
- **文件操作不只是读** —— `presence_mkdir` / `move` / `copy` / `chmod`，文件树右键菜单直接操作；删除走可恢复回收站。
- **Diff 与实时日志** —— 两个远端文件、或远端与本地文件之间的统一 diff；面板里直接跟随日志，不用常驻 `tail -f` 任务。
- **转发会自己回来** —— 保存转发并自动恢复；端口面板发现新监听端口后可一键转发。
- **任务完成通知** —— 后台任务结束时弹 toast（及桌面通知），也可配置本地 `notifyCommand` 推送到手机或守护进程。
- **两种外壳，同一个内核** —— DSH 插件与独立 MCP server（`presence-mcp`，20 个核心工具）共用同一套内核。

## 快速开始

### 1. 安装 DSH 插件

```sh
dsh plugin add @rjfan/dsh-presence@0.20.2
```

从源码安装：

```sh
dsh plugin add /path/to/dsh-presence
```

### 2. 选一台机器，打开工作区

打开 **设置 → Presence → 新建**，从 `~/.ssh/config` 选一台机器（或直接粘贴一条
`ssh` 命令），再选一个远端目录。它会以工作区出现：左侧文件树、终端和 agent 工具
都使用这个远端目录。

在该工作区里启动的会话就是远程会话；在其它地方（例如普通本地项目）启动的会话仍是本地
会话：调用 `presence_exec` / `presence_*` 前必须显式传 `host`，或配置 `PRESENCE_HOST`。

### 3. 开始用

```text
你：把远程 8000 端口转发到本地，然后打开看看
Agent: presence_forward { remotePort: 8000 }
       → http://127.0.0.1:8000
```

## MCP server

同样的能力也提供给装不了 DSH 插件的 agent（Codex CLI、Claude Code、OpenCode、Cursor 等）。

```sh
npx -y presence-mcp            # 20 个工具，走 stdio
```

```jsonc
// Claude Desktop / OpenCode 风格
{
  "mcpServers": {
    "presence": {
      "command": "npx",
      "args": ["-y", "presence-mcp"],
      "env": {
        "PRESENCE_HOST": "server",
        "PRESENCE_WORKSPACE": "server:/srv/app"
      }
    }
  }
}
```

Codex TOML、Claude Code、OpenCode、Cursor/Windsurf 的完整配置见
[mcp/README.md](mcp/README.md)。

## 工作原理

```text
┌───────────────────────────────┐
│  DSH 插件  /  MCP server      │  两种外壳，同一个内核
└──────────────┬────────────────┘
               │
        Presence 内核
        ├── ssh-config  从 ~/.ssh/config 读主机、端口、用户、密钥、跳板
        ├── connection  一条常驻连接：SFTP / exec / PTY + 通道池 + 取消
        └── host pool   每台机器一条连接，按需建立、闲置回收
               │
        SSH（沿用你已有的密钥、known_hosts、跳板、代理）
               │
        目标机：Linux / macOS，原生 sshd
```

| Agent 操作 | 通道 | 远端依赖 |
| --- | --- | --- |
| 读 / 写 / 编辑 / 列目录 / stat | SFTP 子系统 | sshd 自带 `sftp-server` |
| 执行命令、搜索（rg/grep）、git | exec 通道 | 目标机已有的命令 |
| 交互式终端 | shell 通道 + PTY | 目标机的登录 shell |

Linux 主机上的实测：

| 操作 | 延迟 |
| --- | --- |
| `ssh host '<cmd>'`（每次新连接） | 520–540 ms |
| Presence 建连（一次握手，含密钥认证） | 145 ms |
| Presence `sftp stat` | p50 0.6 ms / p95 0.9 ms |
| Presence `exec true`（新通道 + shell） | p50 7.6 ms |
| 8 个 exec 通道并发 | 合计 15 ms |

> 必须保持 TCP_NODELAY：否则请求/响应会撞上 delayed ACK，p95 从 0.9 ms 劣化到 48 ms。

## 工具

DSH 插件提供 25 个工具。在远程工作区会话里，相对路径相对该工作区、`host` 可省略；**本地**
会话必须显式传 `host`（或配置 `PRESENCE_HOST`）—— 不会回退到全局最后激活的工作区。执行时
接受参数别名（`path`/`file_path`/`filePath`、`old`/`oldString`、`new`/`newString`、
`cwd`/`workdir` 等），习惯写法都能用。

<details>
<summary><b>展开全部工具</b></summary>

| 工具 | 说明 |
| --- | --- |
| `presence_hosts` | 列出 SSH 主机、连接状态和默认主机（支持 `format:"json"`）；`workspace:true` 标记当前会话的机器，`degraded` 行带最后一次错误。`default` 是会话作用域：当前会话的挂载主机或 `PRESENCE_HOST`，绝不是全局最后激活的工作区。 |
| `presence_connect` | 建立/复用连接并返回远端身份。 |
| `presence_exec` | 执行远端命令；`pipefail`、`background`、`waitForPort`、结构化 JSON、`saveStdout`；超时默认 300 秒；`progress` 归一化 `\r` 进度条；超长输出落盘到远端文件并返回路径（`tailLines`）；文本报告以 `host: <alias>  remote cwd: <abs>` 开头；危险命令先 dry-run —— `confirm:true` 执行整条命令，`confirm:"partial"` 只执行安全分段。本地会话必须传 `host`。 |
| `presence_jobs` | 后台任务：`list`、`status`、`wait`（含 `timedOut`）、`stop`（`alive`/`verified`/`portReleased`）、`purge`。任务持久化到 `~/.dsh/presence/jobs.json`，含 `pid`/`pgid`；`logPath` 是要 tail 的任务日志（当前内核里即命令 stdout/stderr），`commandLogPath` 是命令自己的日志（当前内核里等于 `logPath`，用 `commandLogPath ?? logPath`）。重启后状态为 `unknown` 直到探活成功，退出码可能缺失。`/presence/api/state` 的 job 行还带 `pid`、`pgid`、`commandLogPath`、`persisted`。 |
| `presence_wait` | 阻塞直到某个远端条件成立（五选一）：`file {path, exists?, minBytes?, mtimeAfter?}`、`grep {path, pattern, count?}`、`process {pid\|pattern, alive?}`、`port {port, state:"open"\|"closed"}`、`job {jobId}`（job 条件不需要 `host`，注册表知道它跑在哪台机器）。返回 `{ met, timedOut, elapsedMs, observed, condition, polls }`；超时是 `met:false`，**不会报错**。`timeoutMs` 默认 120 秒（上限 1 小时），`pollMs`/`intervalMs` 默认 1000 ms。 |
| `presence_read` | 读远端文件，带行号、`offset`/`limit`，`raw:true` 返回逐字节原样内容。 |
| `presence_read_many` | 一次读 1–50 个文件，支持每文件字节/行数上限。 |
| `presence_write` | 原子写；保留 mode；返回真实 mode、字节数和完整 sha256；`ifMatchSha256` 乐观锁；`mode:"append"` 在 EOF 追加，返回追加字节数和总大小（`ifMatchSha256` 仅 overwrite 有效，append 传入会直接报错）；`mode` 也可传八进制字符串（如 `"755"`）设置 overwrite 权限。 |
| `presence_edit` | 精确文本替换或行号区间替换，带紧凑 diff、`dryRun` 和 JSON 字段。 |
| `presence_stat` | 批量 `stat` 1–100 个路径：类型、大小、mode、mtime、可选 sha256；缺失路径返回 `exists:false`。 |
| `presence_mkdir` | 创建远端目录（默认递归）；已存在时幂等成功。 |
| `presence_move` | 同一台机器内重命名/移动；目标已存在时除非 `overwrite:true` 否则拒绝。 |
| `presence_copy` | 复制远端文件（SFTP 流，大文件走 `cp -p`），目录需 `recursive:true`。 |
| `presence_chmod` | 按八进制 mode 改权限（`755`/`0644`），可递归。 |
| `presence_diff` | 两个远端文件、或远端与本地文件的统一 diff；支持上下文行数和 JSON 统计。 |
| `presence_tail` | 读远端文件最后 N 行，或在限定时间内跟随（`follow:true`、`timeoutMs`）。 |
| `presence_search` | 远端 `rg`/`grep` 搜索，`countOnly`，JSON matches。 |
| `presence_glob` | 远端 glob 找文件，带 size/mtime。 |
| `presence_import` | 本地 → 远端二进制安全上传，可设 mode，返回 sha256；支持批量 `paths[]`（1–50）和/或本地 `glob` 到 `to` 目录，逐文件返回结果。 |
| `presence_export` | 远端 → 本地真实文件（内容寻址），供预览或原生程序打开；支持批量 `paths[]` 或远端 `glob`；默认本地文件名取 basename，重名变成 `name-<sha8>.ext`；逐文件返回结果。批量会跳过导出清单（`~/.dsh/presence/exports/manifest.json`）里记录、且远端路径/大小/mtime 仍匹配的文件（`skipExisting:false` 强制重导）；运行中实时进度写到 `~/.dsh/presence/exports/latest.json`，读取用并行 SFTP 请求、单次 30 秒超时，不会把调用挂死。 |
| `presence_forward` | 远端端口转发到 `127.0.0.1`；open/list/close 支持 JSON。 |
| `presence_port_probe` | 检查最多 20 个端口的监听与 TCP 可达性；`expect:open|closed` 可轮询。 |
| `presence_http_probe` | 等端口 → 开转发 → 本地 HTTP 断言 → 关转发 → 验证本地端口已释放。 |
| `presence_terminal` | 持久 PTY：`open` 可带 `cwd`/`command`，`write`（`ackOnly`）、`read`、`close`；tmux 会话可跨重连。 |
| `presence_trash` | 可恢复删除：移入远端回收站、list/restore；支持批量 `paths[]`；返回 `sourceRemoved` 和 `restoreHint`。 |

</details>

### 批量传输与追加写

```text
presence_export { paths: ["/data/a.pt", "/data/b.pt"] }      # files:[{remotePath, localPath, bytes, sha256}]
presence_export { glob: "/data/ckpt-*.pt" }                   # 全部匹配；重名变成 name-<sha8>.ext
presence_import { glob: "dist/*.whl", to: "/data/wheels" }    # 本地 → 远端，逐文件结果
presence_write { path: "/data/train.log", mode: "append", content: "epoch 6 done\n" }
```

单文件仍走原来的 `path`/`to`，上面的写法都不是必需的。

## 路径与工具怎么选

| 路径在哪 | 用什么 | 说明 |
| --- | --- | --- |
| 工作区挂载目录下（`~/.dsh/presence/mounts/...`） | 内置 `read` / `write` / `edit` / `grep` / `glob` | 都直达远端机器；`grep`/`glob` 会自动路由过去 |
| 工作区之外的远端绝对路径（`/data`、`/scratch`、GPFS） | `presence_read` / `write` / `edit` / `stat` / `search` / `glob`（列目录用 `presence_exec`） | 内置工具只看得到挂载目录，看不到整台机器 |
| 本地文件（预览或 Office） | 先 `presence_export`，再 `present` / 原生打开 | 挂载路径是虚拟的，只有真实本地文件能被原生程序打开 |

**本地**会话（cwd 不在挂载根下）里内置工具只操作本地文件；每个 `presence_*` 调用都需要显式
`host`，或一次性配置 `PRESENCE_HOST`。

## 长时间任务

`presence_exec` 会等命令结束，所以训练、构建、起服务都不该直接用它。推荐流程：

```text
1. presence_exec { command: "python train.py --lr 3e-4", background: true, label: "train-3e-4" }
   → { id: "j7", pid: 4242, pgid: 4242, logPath: ".../job.log", commandLogPath: ".../job.out" }
2. presence_jobs { action: "wait", jobId: "j7" }      # 或 presence_wait { job: { jobId: "j7" } }
3. presence_tail { path: <logPath>, follow: true }    # 看进度
   presence_wait { grep: { path: <logPath>, pattern: "epoch 6", count: 1 } }   # 等就绪
```

- `presence_jobs { action: "status" }` 取快照；`stop` 结束进程组并验证端口已释放。任务持久化到
  `~/.dsh/presence/jobs.json`：DSH 重启后先显示 `unknown`，直到探活成功（不会假装 `running`），
  退出码可能缺失。
- `logPath` 是要 tail 的任务日志（当前内核里就是命令输出）；`commandLogPath` 是命令自己的日志，
  没有独立包装日志时等于 `logPath`，所以用 `commandLogPath ?? logPath`。
- `presence_wait` 取代手写 sleep+tail 循环：等端口
  （`presence_wait { port: { port: 8000, state: "open" } }`）、等 checkpoint
  （`presence_wait { file: { path: "/data/ckpt.pt", minBytes: 1000000 } }`）、等日志行或等进程。
  超时返回 `met:false`，是正常结果而不是错误。
- 交互式任务：`presence_terminal { action: "open", session: "train" }`，tmux 会话跨重连存活。
- **不要**在前台 `presence_exec` 里用 `nohup`、`tmux new-session` 或结尾 `&` 跑长任务：登录节点
  会话结束时，集群可能清理残留进程。`background: true` 本身用 `setsid` 脱离；调度器管理的集群
  请用集群自己的启动器（`rlaunch -d …`、`salloc`/`sbatch`），让调度器持有任务。

## 安全与恢复

- **危险命令不会直接执行。** `rm -r/-f`、`git clean -fdx`、`find -delete`、`shred`、
  `truncate`、`dd of=` 会先用 no-op shim 重放以展开真实目标；未设置变量和受保护路径
  （工作区根、家目录、`/`、`.git`）直接拒绝。必须再带 `confirm:true` 才会执行。被拒绝的
  混合命令还会列出可单独执行的安全分段（`Safe segments you can run separately:`），
  `confirm:"partial"` 只执行这些分段；工作区内对单个文件的字面量 `rm -f <路径>` 免检
  （它不可能删掉一棵树）。
- **工作区内删除优先 `presence_trash`**：移动到 `~/.dsh/presence-trash/<时间戳>/` 并返回恢复提示。
- **写入是原子的**，保留原文件 mode；`presence_edit` 锚点不唯一时报错而不是猜。
- **读后写守卫**：内置 `read`/`write`/`edit` 共享读后写守卫。路径 key 会在 `presence://`、挂载路径、
  工作区相对路径、远端绝对路径之间归一；`presence_read` / `presence_write` / `presence_edit` 成功都算
  「已读」（写也算）。`presence_exec` 里 `cat file` **不算** —— 守卫看不到 shell 输出；编辑前请用
  `presence_read` 或内置 `read`。

## 配置

插件从宿主进程环境变量读取：

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `PRESENCE_HOST` | — | **本地**会话的默认 SSH 主机（显式 opt-in；MCP server 也用）。远程工作区会话优先使用自己的挂载主机。 |
| `PRESENCE_WORKSPACE` | — | `host:/abs/path`，绑定一个远程工作区。 |
| `PRESENCE_JOBS_FILE` | `~/.dsh/presence/jobs.json` | 覆盖后台任务持久化文件路径。 |
| `PRESENCE_PASSWORD_<ALIAS>` | — | 某台机器的密码；`<ALIAS>` 大写、非字母数字换成 `_`。 |
| `PRESENCE_MAX_CHANNELS` | 8 | 每连接并发通道数。 |
| `PRESENCE_CONNECT_TIMEOUT_MS` | 25000 | 连接尝试超时。 |
| `PRESENCE_IDLE_TIMEOUT_MS` | 900000 | 空闲连接回收时间（持终端连接不回收）。 |
| `PRESENCE_READ_ONLY` | false | 拒绝写入/编辑；读取、搜索、执行不受影响。 |

完整配置与路径/权限矩阵见 [docs/VERIFICATION.md](docs/VERIFICATION.md) 和
[docs/HANDOFF.md](docs/HANDOFF.md)。

## 开发

```sh
npm install
npm install --prefix .dev --ignore-scripts rollup @rollup/plugin-node-resolve \
  @rollup/plugin-commonjs @rollup/plugin-terser codemirror @codemirror/language-data \
  @codemirror/theme-one-dark
node scripts/build-client.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package.ps1 -Version 0.20.2
# → dist/presence-plugin-0.20.2.zip
```

DSH 升级后，用 Electron-as-Node 对着真实 Harness 运行时验证插件仍能激活
（0.2.1-rc.5 的工具 schema 收紧就是这一步发现的）：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& 'C:\...\DeepSeek Harness.exe' scripts\host-compat-check.mjs   # ACTIVATED OK with 25 tools
```

验证脚本需要一台可 SSH 的主机（标注“不需要真机”的除外）：

```sh
node scripts/regression.mjs server     # 传输层、符号链接、超时、二进制
node scripts/job-probe.mjs server      # 后台任务 + 端口转发
node scripts/feature-probe.mjs server  # wait、会话、pgid、就绪、搜索
node scripts/import-probe.mjs server   # 本地→远端二进制、mode、sha256
node scripts/safety-probe.mjs server   # 危险命令护栏 + 观测状态
node scripts/p0-guard-probe.mjs        # 危险命令分段/单文件豁免（不需要真机）
node scripts/p1-docs-probe.mjs         # README/zh/RELEASE 锚点（不需要真机）
```

## 已知边界

- **本地会话（有意行为）。** 本地会话不传 `host` 调 `presence_*` 现在会报
  `this session is local (cwd=...); pass an explicit host ...` —— 这是 0.20 有意的行为，不是 bug：
  旧逻辑会静默复用上一次激活的远程工作区，可能在别的会话的机器上执行命令。每次调用传 `host`，
  或一次性配置 `PRESENCE_HOST` 作为显式默认值；本地会话仍然不会继承别的工作区，
  `presence_hosts` 的 `default` 同样是会话作用域。
- 读后写守卫看不到 shell 输出：`presence_exec { command: "cat file" }`（或 `sed -n`）**不会**把
  文件标记为已读；`presence_read` 和内置 `read` 才算，`presence_write`/`presence_edit` 也算已读。
  只 `exec cat` 过再让内置 `edit` 编辑，仍可能触发守卫。
- 挂载路径（`~/.dsh/presence/mounts/...`）是虚拟的：对 `ctx.fs` / agent 工具有效，
  但 Explorer、Office、宿主 Python 看不到 —— 需要先用 `presence_export`。
- `presence_exec` 超时默认 300 秒；更长的任务必须用 `background: true`（前台输出超限会
  落盘到远端文件，`tailLines` 保留长报告末尾）。后台任务持久化到
  `~/.dsh/presence/jobs.json`；DSH 重启后状态是 `unknown` 直到探活成功 —— 不要把持久化记录
  当成还在运行，退出码可能缺失。要 tail 的日志用 `commandLogPath ?? logPath`（当前内核里
  `logPath` 就是命令输出）。
- `presence_export` 单文件上限 64 MiB，批量按顺序执行。运行中进度写到
  `~/.dsh/presence/exports/latest.json`；单次读取 30 秒超时（不会挂死调用）；重跑时会跳过
  导出清单（`~/.dsh/presence/exports/manifest.json`）里远端路径/大小/mtime 仍匹配的文件。
  跨慢速公网搬多 GB 数据时，请改用 shell 里的 `scp`/`rsync`/`tar`，不要用单次 export 调用。
- 登录节点可能在会话结束时清理残留进程：不要在前台 `presence_exec` 里用 `nohup` /
  `tmux new-session` / `&` 跑长任务。用 `background: true`（`setsid` 脱离）或
  `presence_terminal`（tmux）；集群上让调度器持有任务（`rlaunch -d`、`salloc`/`sbatch`）。
- 参数别名可用（`path`/`file_path`/`filePath`、`old`/`oldString`、`new`/`newString`、
  `replaceAll`/`replace_all`、`dryRun`/`dry_run`、`cwd`/`workdir`）；schema 里记录的是规范名。
- sshd 的 `MaxSessions`（默认 10）限制并发通道；连接池最多用 8 个。
- PTY 终端跟随连接存活；跨重连的 shell 需要目标机有 `tmux`（`presence_terminal { session }` 自动使用）。
- ProxyJump / ProxyCommand 会被解析并提示，但目前不用于实际拨号。
- `@` 文件补全按工作区惰性索引远端树（约 10 秒缓存）；超大目录首次查询可能要几秒。
- 端口自动恢复在连接重建时执行；若保存的本地端口已被占用，会回退到其它空闲端口。

## 参与贡献

欢迎 issue 和 PR。新功能请先开 issue 描述你的远程工作流；修 bug 请保持 diff 聚焦，
行为变化时在 `scripts/` 下补一个探针。

## License

[MIT](LICENSE)

## Star History

[![Star History Chart](assets/star-history.png)](https://star-history.com/#fanrj3/dsh-presence&Date)
