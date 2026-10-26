# Presence MCP server

让 **Codex CLI / Claude Code / OpenCode / Cursor / Windsurf** 这类不支持 DSH 插件的 agent，
也能用 Presence 的远程机器能力：一条常驻 SSH 连接，远端**零安装**，工具和插件版一致。

这是独立子包，**不修改 DSH 插件任何文件**：插件里可复用的内核
（`pool.js`、`core/connection.mjs`、`ssh-config.mjs`、`remote-search.js`、`destructive.js`、
`localpaths.js`、`mounts.js` 及其依赖）以**原样副本**放在本包的 `src/` 下随 npm 包发布，
所以安装后不需要仓库里的插件目录。`scripts/sync-kernel.mjs` 只用于仓库内同步
（`--check` 会挡住 vendored 副本漂移），`prepack` 会自动跑它。

当前版本 **0.2.3**，**20 个工具**（0.2.3 新增 `presence_stat`、`presence_port_probe`、
`presence_http_probe`，并给既有工具补齐 `format:"json"`；压力测试复盘见
[TOOLTEST-REPORT.md](TOOLTEST-REPORT.md)）。

## 安装

### 从 npm（推荐）

```bash
npm i -g presence-mcp          # 全局安装，得到 presence-mcp 命令
npx -y presence-mcp --check    # 免安装试跑：打印主机/环境/工具数摘要
presence-mcp --version         # 0.2.3
```

包是**自包含**的：内核副本在包内 `src/`，安装后不需要插件仓库。
要求 Node **>= 22.19**，`~/.ssh/config` 里已有可用主机（或 Presence 手动主机
`~/.dsh/presence/hosts.json`），能用 key / ssh-agent 登录。

### 从源码（开发/改内核）

```bash
git clone https://github.com/fanrj3/dsh-presence.git presence && cd presence
npm install                 # 插件运行时的 ssh2（已存在可跳过）
cd mcp && npm install       # MCP SDK + zod + ssh2
node scripts/sync-kernel.mjs --check   # 确认随包内核与插件 src/ 一致（不写文件）
```

改了插件 `src/` 里的内核后，在 `mcp/` 里跑 `node scripts/sync-kernel.mjs` 重新 vendoring；
`npm pack` / `npm publish` 的 `prepack` 会拒绝发布与插件源码不一致的副本。

## 运行

```bash
presence-mcp            # 全局安装后的命令
npx -y presence-mcp     # 不安装，直接用最新版
node mcp/server.mjs     # 从源码运行
```

它是一个 **stdio** MCP server：由客户端负责启动，不要在终端里手动跑着等输入。
stdout 是 JSON-RPC 通道，日志只写 stderr。`--check` / `--version` / `--help` 是安全的自检入口。

## 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `PRESENCE_HOST` | 无 | 不给工具传 `host` 时的默认机器别名 |
| `PRESENCE_WORKSPACE` | 无 | `host:/abs/path`，同时作为默认主机和相对路径的根 |
| `PRESENCE_CWD` | 无 | 只有路径、没有主机时，相对路径的根（绝对远端路径） |
| `PRESENCE_READ_ONLY` | `0` | `1` 时拒绝 write / edit / import / trash restore |
| `PRESENCE_PASSWORD_<ALIAS>` | 无 | 该主机的 SSH 密码（别名大写、非字母数字转 `_`），优先用 key/agent |
| `PRESENCE_MAX_CHANNELS` | `8` | 每连接并发通道数 |
| `PRESENCE_CONNECT_TIMEOUT_MS` | `25000` | 连接超时 |
| `PRESENCE_IDLE_TIMEOUT_MS` | `900000` | 空闲回收时间 |
| `PRESENCE_SESSION` | `mcp-<pid>` | 后台任务归属标记 |

密钥认证优先：ssh-agent → `IdentityFile` → `~/.ssh/id_*`；密码只在需要时使用。

## 客户端配置

下面的例子用**全局安装**后的 `presence-mcp` 命令；不想全局装就把命令换成 `npx -y presence-mcp`
（Codex/Claude/OpenCode 都支持），或从源码运行时用 `node` + `server.mjs` 的**绝对路径**
（客户端多数没有 `cwd`，源码方式必须绝对路径）。

### Codex CLI

`~/.codex/config.toml`（Windows：`C:\Users\<you>\.codex\config.toml`）：

```toml
[mcp_servers.presence]
command = "presence-mcp"
args = []
env_vars = ["PRESENCE_PASSWORD_MY_SERVER"]   # 从启动 Codex 的环境继承
startup_timeout_sec = 30
tool_timeout_sec = 120

[mcp_servers.presence.env]                  # 非密钥的字面量
PRESENCE_HOST = "server"
```

```bash
codex mcp add presence --env PRESENCE_HOST=server -- presence-mcp
# 免安装：codex mcp add presence --env PRESENCE_HOST=server -- npx -y presence-mcp
codex mcp list
```

注意：Codex **不做 `${VAR}` 插值**，密钥只能用 `env_vars` 继承或直接写值。

### Claude Code

```bash
claude mcp add --scope user --env PRESENCE_HOST=server --transport stdio \
  presence -- presence-mcp
claude mcp list
```

项目级 `.mcp.json`：

```json
{
  "mcpServers": {
    "presence": {
      "type": "stdio",
      "command": "presence-mcp",
      "args": [],
      "env": { "PRESENCE_WORKSPACE": "server:/srv/app/project" },
      "timeout": 600000
    }
  }
}
```

Claude Code 没有 `cwd` 字段，从源码运行务必写绝对路径；项目级配置首次需在项目内批准。

### OpenCode（2.x）

`~/.config/opencode/opencode.json`（或项目根 `opencode.json`）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "presence": {
        "type": "local",
        "command": ["presence-mcp"],
        "environment": { "PRESENCE_WORKSPACE": "server:/srv/app/project" },
        "disabled": false,
        "timeout": { "startup": 30000, "execution": 120000 }
      }
    }
  }
}
```

```bash
opencode mcp list
opencode debug config   # 看合并后的 mcp 块
```

注意 2.x 是 `mcp.servers.<name>` + `disabled`；官方文档页仍写 1.x 的 `mcp.<name>` + `enabled`，
两版都贴在上面了（1.x 把 `servers` 层去掉、`disabled` 换 `enabled`、timeout 用数字）。

### Cursor

`~/.cursor/mcp.json` 或项目 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "presence": {
      "type": "stdio",
      "command": "presence-mcp",
      "args": [],
      "env": { "PRESENCE_HOST": "server" }
    }
  }
}
```

验证：Customize → MCPs；Output → MCP Logs。

### Windsurf / Devin

`%APPDATA%\devin\mcp_config.json`（旧版可能仍是 `~/.codeium/windsurf/mcp_config.json`）：

```json
{
  "mcpServers": {
    "presence": {
      "command": "presence-mcp",
      "args": [],
      "env": { "PRESENCE_HOST": "server" }
    }
  }
}
```

## 工具

共 **20** 个，`host` 都可省略（走默认主机）。`format:"json"` 的工具返回**单个**紧凑 JSON
文本块（数组或对象），可直接 `JSON.parse`。

| 工具 | 作用 | 主要参数 |
| --- | --- | --- |
| `presence_list_hosts` | 列出可连的机器与连接状态（`*` 标默认主机；JSON 含 `state/connected/default`） | `format?` |
| `presence_connect` | 建立/复用连接，返回远端身份（JSON 含 `user/hostname/kernel/arch/platform/connectedAtMs`） | `host`, `format?` |
| `presence_ls` | 列一个远端目录（`recursive` 深度 6、上限 2000 项；`totalBytes` 汇总文件大小） | `path?`, `limit?`, `recursive?`, `totalBytes?`, `format?` |
| `presence_exec` | 远端执行命令；`script` 走临时脚本文件（免多层引号）；危险命令 dry-run 的 JSON 带 `targets/requiresConfirm` | `command?`, `script?`, `cwd?`, `timeoutMs?`, `background?`, `confirm?`, `maxOutput?`, `format?`, `saveStdout?`, `waitForPort?` |
| `presence_read` | 读远端文件（默认带行号，`raw:true` 返回精确内容） | `path`, `offset?`, `limit?`, `numbered?`, `raw?` |
| `presence_read_many` | 一次读多个文件（默认每文件 16 KiB、总计 256 KiB，可调；`hash:true` 给完整文件的 sha256） | `paths`, `raw?`, `limit?`, `maxBytesPerFile?`, `maxBytesTotal?`, `hash?`, `format?` |
| `presence_write` | 原子写文件（`ifMatchSha256` 乐观锁；回真实 mode/大小/完整 sha256） | `path`, `content`, `mode?`, `ifMatchSha256?`, `format?` |
| `presence_edit` | 精确替换或行范围替换，返回 diff（`dryRun` 用 `actualSizeBytes`/`projectedSizeBytes` 区分现值与预测值） | `path`, `oldText?`, `newText?`, `startLine?`, `endLine?`, `replaceAll?`, `dryRun?`, `format?` |
| `presence_search` | 用远端 rg/grep 搜索（JSON 给 `matchCount` + `{file,line,text}`） | `pattern`, `path?`, `include?`, `limit?`, `countOnly?`, `format?` |
| `presence_glob` | glob 找文件（大小/时间；JSON 是精确的 `sizeBytes/mtimeISO/mtimeMs`） | `pattern`, `path?`, `limit?`, `format?` |
| `presence_stat` | **新**：一次 stat 1–100 个路径（可选 sha256）；缺失路径返回 `exists:false` 而不是报错 | `paths`, `hash?`, `followSymlinks?`, `format?` |
| `presence_import` | 本地 → 远端（sha256；JSON 含完整 sha256 与 mode） | `source`, `to`, `mode?`, `overwrite?`, `format?` |
| `presence_export` | 远端 → 本地导出目录（`format:"json"`、`name` 覆盖文件名） | `path`, `to?`, `name?`, `format?` |
| `presence_jobs` | 后台任务 start/list/status/wait/stop/purge（`wait` 带 `timedOut`；`stop` 可传 `port` 验证端口释放） | `action`, `command?`, `jobId?`, `all?`, `timeoutMs?`, `verify?`, `port?`, `format?` |
| `presence_forward` | 远程端口映射到本地（JSON 的 open/list 带 `state` 与 `createdAt`；close 返回端口释放探测） | `action`, `remotePort?`, `localPort?`, `forwardId?`, `format?` |
| `presence_port_probe` | **新**：一次探测 1–20 个端口的监听（ss + pid/process）与 TCP 连接；`expect`/`waitMs` 直接给出 ok | `ports`, `expect?`, `waitMs?`, `probe?`, `format?` |
| `presence_http_probe` | **新**：转发 + HTTP 断言 + 必定关闭隧道 + 本地端口释放，一次调用完成 | `remotePort`, `paths?`, `expectStatus?`, `expectBody?`, `localPort?`, `timeoutMs?`, `waitForPort?`, `format?` |
| `presence_terminal` | 持久终端 / tmux（open 可带 `cwd`/`command`；`write` 可 `ackOnly`；五种动作都支持 JSON） | `action`, `terminalId?`, `data?`, `cwd?`, `command?`, `ackOnly?`, `session?`, `waitMs?`, `format?` |
| `presence_trash` | 回收站 trash/list/restore（list 可过滤；trash 支持 `paths[]` 批量，list 只给一个 `movedAtISO`） | `action`, `path?`, `paths?`, `trashPath?`, `to?`, `limit?`, `format?` |
| `presence_status` | 查看生效配置/主机/资源数量（含 effective host/cwd 与 `node`/`uptimeMs`，排障先看这个） | — |

路径写法：绝对路径、`~/x`、`presence://host/abs`、或相对 `PRESENCE_WORKSPACE` / `PRESENCE_CWD`。

## 行为约定

- **常驻连接**：同一进程内每个别名一条连接；60+ 次工具调用的集成测试里只有 1 次握手。
- **危险命令**：`rm -r`、`git clean`、`find -delete`、`truncate` 等默认 **dry-run**，返回计划，
  传 `confirm: true` 才执行；指向 `/`、home、工作区根的路径一律拒绝（即使 confirm）。
  `script` 模式的破坏性检测只看脚本文本（无法解析具体目标），命中时同样要求 `confirm: true`。
- **exec 脚本**：`script` 写到远端 `/tmp/presence-exec-<random>.sh`（0700），用 `bash`（没有则 `/bin/sh`）
  执行，结束后（含失败/拒绝）必定删除；背景任务在 `bash` 打开文件后才删除，实测 `sleep 2` 后的输出仍完整。
- **read_many 预算**：每个文件先按 `maxBytesPerFile`（默认 16 KiB）截断并单独标记 `truncated`；
  所有文件总和超过 `maxBytesTotal`（默认 256 KiB）时，从列表尾部开始裁剪并标 `truncatedByTotal`。
  单个大文件不再吃掉全部预算。`hash:true` 时对**内容完整**的文件附带 `sha256`（直接从返回内容
  本地计算，不额外读远端）；被截断的文件为 `null`，文本模式对应一行 `sha256: ...`。
- **jobs**：`list` 默认隐藏 `state="exited"`，`all:true` 显示历史；`purge` 只是在 MCP 进程内过滤列表
  （`{purged:[...]}`），远端进程/日志命名空间不变，`status`/`wait`/`stop` 仍可按 id 访问。
  `wait` 超时返回 `timedOut:true`（此时 `state:"running"`、`exitSummary:null`）；运行中的
  `status` 也是 `exitSummary:null`，不再报 "unknown"。`stop` 加 `port:N` 会在停止后轮询该远端端口，
  返回 `portReleased`（`true` 已释放 / `false` 仍在监听 / `null` 无法判断）。
- **端口探测**：`presence_port_probe` 一次 exec 同时取 `ss -ltnp`（pid/process）和 TCP 连接结果
  （`bash /dev/tcp`，无 bash 回退 `python3`）；`expect:"open"|"closed"` 时 `ok` 就是断言结果，
  `waitMs` 每 250 ms 轮询。`probe:"skipped"` 表示远端没有 bash 也没有 python3。
- **HTTP 探测**：`presence_http_probe` 会自动 `openForward` → 本地 `fetch` → **finally 关闭隧道**
  → 探测本地端口已释放；`pass` = 所有状态码符合 `expectStatus` 且所有 `expectBody` 子串都出现在
  拼接后的响应体里。断言失败也返回完整结果（`pass:false` + `missingBody`），不抛异常。
- **stat/哈希**：`presence_stat` 一次操作 1–100 个路径，`hash:true` 时对普通文件算 sha256；
  缺失路径是数据（`exists:false`）而不是错误，所以可以直接拿它做"文件还在不在"的检查。
  默认不穿透符号链接，`followSymlinks:true` 才跟随。
- **写保护**：`presence_write` 的 `ifMatchSha256` 是乐观锁：先算远端当前 sha256，不一致直接失败并
  同时给出期望/当前哈希，文件一个字节都不动。文本返回完整 sha256。
- **edit 尺寸语义**：`dryRun:true` 时 JSON 的 `actualSizeBytes` 是磁盘现值、`projectedSizeBytes`
  是编辑后的预测值、`sizeBytes` = 现值；真正写入后 `sizeBytes` = 落盘大小。文本会写成
  `dry run: 12 B → 19 B projected`，不再把预测值当实际值。
- **terminal**：`open` 支持 `cwd`（默认工作区根）和 `command`（默认 `bash`），JSON 返回
  `{terminalId,host,cwd,shell,reused}`；同一 tmux 会话再次 open 会复用（`reused:true`）。
  `write` 默认回显输出，`ackOnly:true` 只回 `{terminalId,writtenBytes,output:null}`，输出交给
  `read`（`read` 仍是增量）。
- **forward close**：关闭后真实探测 `127.0.0.1:<localPort>`（约 500 ms），返回
  `state:"closed"`、`localPort`、`portReleased`，不必再手工 `ss`/`fetch` 三重确认。
  `open` 与 `list` 的 JSON 还带 `createdAt`（ISO-8601 UTC，含毫秒），方便区分同一端口的新旧隧道。
- **status**：`presence_status` 在配置/主机/资源计数之外，额外给 `node`（Node 版本）与
  `uptimeMs`（MCP 进程运行时长），排障时不用再问"你跑的是哪个 node"。
- **导出命名**：`name` 会去掉路径分隔符与 `..`，结果仍被限制在导出目录内；`format:"json"` 返回
  `{remotePath, localPath, sizeBytes, sha256}`，多张截图不再按哈希前缀人工匹配。
- **行范围编辑**：`startLine`/`endLine`（1-based，含端点）+ `newText` 直接替换整段行，
  `newText:""` 即删除整段；与 `oldText` 互斥，`dryRun` 同样可用，写入仍是原子写并保留原 mode。
- **回收站**：优先 `presence_trash`，远端 `~/.dsh/presence-trash`，可 `restore`。`trash` 支持
  `paths[]` 一次 1–50 个（逐项结果，单项失败不影响其它项）；`list` 的 JSON 只给一个 `movedAtISO`，
  不再重复三份时间。
- **后台任务/终端** 在 MCP 进程退出后仍存活，记得显式 stop/close。
- `ProxyJump` 被忽略（直连 `HostName`，与插件一致）；需要跳板时请让 ssh config 直接可达。

## 安全边界

- stdio-only，不监听端口；只有启动它的客户端能调用。
- 密码可由 `PRESENCE_PASSWORD_<ALIAS>` 提供；默认只走 key/ssh-agent。
- `PRESENCE_READ_ONLY=1` 可做只读演示/审计。
- 单文件传输上限 64 MiB；读取预览上限 32 MiB；危险操作有 guard + 回收站。

## 验证

分五层，详见 [TESTING.md](TESTING.md)：

```bash
node mcp/test/smoke.mjs                  # 协议冒烟（内存传输，任何环境）
node mcp/test/integration.mjs server   # 真实主机端到端（内存传输 + 真 SSH）
node mcp/test/packaged.mjs <install-dir> # 打包安装自检（npm pack + install 后的包）
powershell -File mcp/test/stdio-e2e.ps1      # 真实 stdio 传输（.NET 管道，任何环境）
powershell -File mcp/test/opencode-e2e.ps1   # OpenCode 问答实测（普通 PowerShell）
```

发布前：

```bash
cd mcp
node scripts/sync-kernel.mjs --check   # 随包内核与插件 src/ 无漂移
npm pack                               # 生成 presence-mcp-0.2.3.tgz
npm publish --dry-run --access public  # 只校验，不真发
```

当前结果：smoke **9/9**（`tools/list` = 20），integration **103/103**（exec/读写/编辑/ls/搜索/glob/
上传下载/回收站/后台任务/端口转发经隧道取 HTTP 200/终端往返；0.2.3 新增 `presence_stat`、
`presence_port_probe`、`presence_http_probe` 与 list_hosts/connect/search/glob/import/terminal
的 JSON、jobs `timedOut`/`stop port`、trash 批量、edit actual/projected、write `ifMatchSha256`、
exec 危险命令 JSON；本轮补 read_many `hash`、forward `createdAt`、status `node`/`uptimeMs`
—— 逐项见 [TOOLTEST-REPORT.md](TOOLTEST-REPORT.md)），打包安装 **7/7**，stdio **5/5**，
**OpenCode 2.1.4 实测 4/4**（见 [TESTING.md](TESTING.md)：真实工具调用、中文回答、错误恢复；
后续跑因 OpenCode 免费模型额度耗尽出现 SKIP，换一个有额度的模型即可）。
游戏构建长任务（3 阶段 / 73 次工具调用）的摩擦与改进映射见 [GAME-LONGTASK.md](GAME-LONGTASK.md)。

## 为什么用 SDK v1 而不是 v2

`@modelcontextprotocol/sdk@1.32.2` 覆盖到 2025-11 协议，当前 Codex/Claude Code/OpenCode 都能正常协商；
v2（`@modelcontextprotocol/server@2.4.0`，2026-07 协议）是当前线，但需要 `serveStdio` 工厂 +
zod v4，且 v1→v2 类不互通。迁移时改动集中在 `app.mjs`/`server.mjs`（imports + transport），
工具实现不用动；升级前先跑 smoke/integration。

## 已知限制

- 不能拦截客户端自己的 grep/glob（那是 DSH 插件才有的能力）；请显式调用这里提供的工具。
- 没有 Web 面板/文件树/CodeMirror 预览——这是给 agent 用的 MCP 层。
- `presence_read_many` 默认可能返回最多约 256 KiB 正文；上下文紧张时显式调小 `maxBytesTotal` /
  `maxBytesPerFile`，或分两次读。
- `presence_jobs purge` 只在 MCP 进程内隐藏列表项，不会删除远端日志/状态文件；进程重启后历史会重新出现
  （kernel 本身没有 delete API）。
- ssh config 的 `ProxyJump` 不生效（见上）。
- `exportDirectory()` 固定为系统临时目录 `presence-exports`。
- `presence_stat` 的 `hash:true` 会在远端完整读一遍文件：大文件请只对需要的路径开启，或改用
  `presence_import`/`presence_export` 自带的分块传输与 sha256。
- `presence_read_many` 的 `hash:true` 只对**内容完整**的文件给 sha256，被 `limit`/字节预算/总量预算
  截断的文件一律 `null`（拿到完整内容才能算文件哈希）。
- `presence_port_probe` 的 pid/process 依赖远端 `ss` 与权限；`ss` 不可用时退化为只看 TCP 连接。
- `presence_http_probe` 只做 GET，且只探测远端 `127.0.0.1`（与 forward 一致）；需要自定义 Host
  头或 POST 时用 `presence_exec` + `curl`。
