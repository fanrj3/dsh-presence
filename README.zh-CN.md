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
- **可恢复的删除** —— 危险 shell 命令先 dry-run；`presence_trash` 移入远端回收站并可恢复。
- **两种外壳，同一个内核** —— DSH 插件与独立 MCP server（`presence-mcp`，20 个工具）共用同一套内核。

## 快速开始

### 1. 安装 DSH 插件

```sh
dsh plugin add @rjfan/dsh-presence@0.17.8
```

从源码安装：

```sh
dsh plugin add /path/to/dsh-presence
```

### 2. 选一台机器，打开工作区

打开 **设置 → Presence → 新建**，从 `~/.ssh/config` 选一台机器（或直接粘贴一条
`ssh` 命令），再选一个远端目录。它会以工作区出现：左侧文件树、终端和 agent 工具
都使用这个远端目录。

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

DSH 插件提供 18 个工具。相对路径相对当前远程工作区；在工作区里 `host` 可省略。

<details>
<summary><b>展开全部工具</b></summary>

| 工具 | 说明 |
| --- | --- |
| `presence_hosts` | 列出 SSH 主机、连接状态和默认主机（支持 `format:"json"`）。 |
| `presence_connect` | 建立/复用连接并返回远端身份。 |
| `presence_exec` | 执行远端命令；`pipefail`、`background`、`waitForPort`、结构化 JSON、`script`、`saveStdout`；危险命令先 dry-run。 |
| `presence_jobs` | 后台任务：`list`、`status`、`wait`（含 `timedOut`）、`stop`（`alive`/`verified`/`portReleased`）、`purge`。 |
| `presence_read` | 读远端文件，带行号、`offset`/`limit`，`raw:true` 返回逐字节原样内容。 |
| `presence_read_many` | 一次读 1–50 个文件，支持每文件字节/行数上限。 |
| `presence_write` | 原子写；保留 mode；返回真实 mode、字节数和完整 sha256；`ifMatchSha256` 乐观锁。 |
| `presence_edit` | 精确文本替换或行号区间替换，带紧凑 diff、`dryRun` 和 JSON 字段。 |
| `presence_ls` | 列目录；`recursive`、`totalBytes`、JSON 输出。 |
| `presence_stat` | 批量 `stat` 1–100 个路径：类型、大小、mode、mtime、可选 sha256；缺失路径返回 `exists:false`。 |
| `presence_search` | 远端 `rg`/`grep` 搜索，`countOnly`，JSON matches。 |
| `presence_glob` | 远端 glob 找文件，带 size/mtime。 |
| `presence_import` | 本地 → 远端二进制安全上传，可设 mode，返回 sha256。 |
| `presence_export` | 远端 → 本地真实文件（内容寻址），供预览或原生程序打开。 |
| `presence_forward` | 远端端口转发到 `127.0.0.1`；open/list/close 支持 JSON。 |
| `presence_port_probe` | 检查最多 20 个端口的监听与 TCP 可达性；`expect:open|closed` 可轮询。 |
| `presence_http_probe` | 等端口 → 开转发 → 本地 HTTP 断言 → 关转发 → 验证本地端口已释放。 |
| `presence_terminal` | 持久 PTY：`open` 可带 `cwd`/`command`，`write`（`ackOnly`）、`read`、`close`；tmux 会话可跨重连。 |
| `presence_trash` | 可恢复删除：移入远端回收站、list/restore；支持批量 `paths[]`；返回 `sourceRemoved` 和 `restoreHint`。 |

</details>

## 安全与恢复

- **危险命令不会直接执行。** `rm -r/-f`、`git clean -fdx`、`find -delete`、`shred`、
  `truncate`、`dd of=` 会先用 no-op shim 重放以展开真实目标；未设置变量和受保护路径
  （工作区根、家目录、`/`、`.git`）直接拒绝。必须再带 `confirm:true` 才会执行。
- **工作区内删除优先 `presence_trash`**：移动到 `~/.dsh/presence-trash/<时间戳>/` 并返回恢复提示。
- **写入是原子的**，保留原文件 mode；`presence_edit` 锚点不唯一时报错而不是猜。
- **读后写守卫**：内置 `read`/`write`/`edit` 共享读后写守卫；`presence_write` 也会记账，两套 API 可混用。

## 配置

插件从宿主进程环境变量读取：

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `PRESENCE_HOST` | — | 默认 SSH 主机（`~/.ssh/config` 别名或手动主机）。 |
| `PRESENCE_WORKSPACE` | — | `host:/abs/path`，绑定一个远程工作区。 |
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
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package.ps1 -Version 0.17.8
# → dist/presence-plugin-0.17.8.zip
```

验证脚本需要一台可 SSH 的主机：

```sh
node scripts/regression.mjs server     # 传输层、符号链接、超时、二进制
node scripts/job-probe.mjs server      # 后台任务 + 端口转发
node scripts/feature-probe.mjs server  # wait、会话、pgid、就绪、搜索
node scripts/import-probe.mjs server   # 本地→远端二进制、mode、sha256
node scripts/safety-probe.mjs server   # 危险命令护栏 + 观测状态
```

## 已知边界

- 挂载路径（`~/.dsh/presence/mounts/...`）是虚拟的：对 `ctx.fs` / agent 工具有效，
  但 Explorer、Office、宿主 Python 看不到 —— 需要先用 `presence_export`。
- sshd 的 `MaxSessions`（默认 10）限制并发通道；连接池最多用 8 个。
- PTY 终端跟随连接存活；跨重连的 shell 需要目标机有 `tmux`（`presence_terminal { session }` 自动使用）。
- ProxyJump / ProxyCommand 会被解析并提示，但目前不用于实际拨号。

## 参与贡献

欢迎 issue 和 PR。新功能请先开 issue 描述你的远程工作流；修 bug 请保持 diff 聚焦，
行为变化时在 `scripts/` 下补一个探针。

## License

[MIT](LICENSE)

## Star History

[![Star History Chart](assets/star-history.png)](https://star-history.com/#fanrj3/dsh-presence&Date)
