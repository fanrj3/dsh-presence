# Presence MCP 测试记录与实测指南

这套 MCP server 用五层验证，从"协议对不对"到"装成 npm 包还能不能用"再到"真实客户端好不好用"：

| 层 | 命令 | 需要 | 本机结果 |
| --- | --- | --- | --- |
| 1. 协议冒烟（内存传输，不 spawn） | `node mcp/test/smoke.mjs` | 无 | **9/9 PASS** |
| 2. 真实主机端到端（内存传输 + 真 SSH） | `node mcp/test/integration.mjs server` | 可连的 ssh 主机 | **103/103 PASS** |
| 3. 打包安装自检（npm pack + 临时安装） | `node mcp/test/packaged.mjs <install-dir>` | Node 可 spawn 子进程 | **7/7 PASS** |
| 4. 真实 stdio 传输 | `powershell -File mcp/test/stdio-e2e.ps1` | 无（用 .NET 管道） | **5/5 PASS** |
| 5. 真实客户端（OpenCode 问答） | `powershell -File mcp/test/opencode-e2e.ps1` | opencode 2.1.4 + 有额度的模型 | **4/4 PASS** |

## 本环境（DSH sandbox）里能做到什么

已实测通过：

- **协议层**：`initialize`、`tools/list`（**20** 个工具）、`inputSchema`、注解（`readOnlyHint` / `destructiveHint`）、
  `presence_list_hosts`、`presence_status`、未知主机的可读报错 + hint —— **9/9**
- **真实 SSH**：exec、相对路径 write→read→edit、search、glob、import/export（sha256 一致）、
  trash→list→restore、jobs start→stop、forward open→**经隧道取到 HTTP 200**、terminal 往返；
  以及 read_many 预算、exec `script`、background JSON、jobs `all`/`purge`/`exitSummary`、
  forward close `portReleased`、ls `recursive`/`totalBytes`、export JSON/`name`、edit 行范围；
  0.2.0 又补了 `presence_stat`、`presence_port_probe`、`presence_http_probe`、六种 JSON 格式、
  jobs `timedOut`/`stop port`、trash 批量、edit actual/projected、write `ifMatchSha256`、
  exec 危险命令 JSON；本轮再加 read_many `hash`、forward `createdAt`、status `node`/`uptimeMs`
  —— **103/103**（逐项见 [TOOLTEST-REPORT.md](TOOLTEST-REPORT.md)）
- **打包自检**：`npm pack` → 临时目录 `npm install <tarball>` → 包内 bin 的 `--version` /
  `--check` / `--help`，再用 stdio 跑 `initialize` + `tools/list` + `presence_list_hosts` +
  `presence_status` —— **7/7**（`presence@0.2.0`、20 工具；包内没有 `../../src`，内核来自
  vendored `src/`）
- **CLI 自检**：`node mcp/server.mjs --check` 输出宿主/工具/环境摘要；`--help`、`--version` 正常

补充：Node 版 `node mcp/test/stdio-client.mjs` 与第 3 层的 `packaged.mjs` 都要 spawn 子进程；
受限 DSH sandbox（禁止 Node 子进程管道）里会 `spawn EPERM`，普通终端 / full-access 会话可正常跑。
它们与 `stdio-e2e.ps1` 走的是同一条 stdio JSON-RPC 路径。

OpenCode v2.1.4 依赖子进程：`opencode serve` 能启动，但打开项目时内部
`uv_spawn git rev-parse ...` 被同样的策略拒绝，`GET /api/location` 返回 500；它启动 MCP server
（也是 spawn + pipe）时同样会被拒绝。因此**客户端级实测必须在普通 PowerShell（不受 DSH sandbox 限制）里跑**。

## 第 3 层：打包安装自检（self-contained）

包发布后必须不依赖仓库里的插件 `src/`：内核已 vendored 到 `mcp/src/`，`prepack` 用
`node scripts/sync-kernel.mjs --check` 挡住漂移。验证方式是把**打出来的 tarball**装进一个
干净临时目录，再跑包里的 bin：

```powershell
cd D:\04_Dev\Presence-mcp\mcp
node scripts/sync-kernel.mjs --check   # 10 个内核文件与插件 src/ 一致
npm pack                               # presence-mcp-0.2.0.tgz

$dir = "$env:TEMP\presence-mcp-install-test"
Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
New-Item -ItemType Directory $dir | Out-Null
cd $dir
npm init -y | Out-Null
npm install D:\04_Dev\Presence-mcp\mcp\presence-mcp-0.2.0.tgz --no-audit --no-fund

.\node_modules\.bin\presence-mcp.cmd --check   # JSON：server/version/tools=20/hosts
.\node_modules\.bin\presence-mcp.cmd --help    # 用法
node D:\04_Dev\Presence-mcp\mcp\test\packaged.mjs .\node_modules\presence-mcp
```

`packaged.mjs` 会启动**已安装**的 bin（Windows 上经 `.cmd` shim，Unix 上直接跑 shim），
断言 `initialize` 返回 `presence@0.2.0`、`tools/list` 20 个工具，并实际调用
`presence_list_hosts` / `presence_status`——这一步同时证明 vendored 的 `pool.js`、
`core/ssh-config.mjs`、`mounts.js` 在 `node_modules` 里能正常加载。装好的包里没有 `test/`、
`scripts/`（`files` 白名单只放运行时文件），但 `--check` 仍必须能跑通，说明 `src/` 已完整随包。

预期：**7/7 PASS**，stdout 形如

```
# bin: C:\...\presence-mcp-install-test\node_modules\presence-mcp\server.mjs
PASS  已安装 bin --version — "0.2.0"
PASS  已安装 bin --check 输出 JSON（20 工具） — version=0.2.0 tools=20 hosts=13
PASS  已安装 bin --help — presence-mcp 0.2.0
PASS  stdio initialize — presence@0.2.0
PASS  stdio tools/list 返回 20 个工具 — 20 tools
PASS  stdio presence_list_hosts（vendored ssh-config 生效） — ...
PASS  stdio presence_status（vendored kernel 生效） — node=v25.2.1 uptimeMs=...
7/7 passed
```

另外两个发布检查：

```powershell
cd D:\04_Dev\Presence-mcp\mcp
npm pack --dry-run --json        # 文件清单：只有 server/app/tools/lib/src + README/LICENSE，无 ../、无 test scratch
npm publish --dry-run --access public   # 只走发布校验，不真发（npm whoami 需要已登录）
```

## 第 4 层：真实 stdio 传输

```powershell
cd <repo>
powershell -NoProfile -ExecutionPolicy Bypass -File mcp/test/stdio-e2e.ps1
# 本机结果：5/5 passed
#   initialize            presence@0.2.0, protocol 2025-06-18
#   tools/list            20 tools
#   presence_exec         Linux / server (exit=0 · 15 ms)
#   presence_status       hosts=13 readOnly=False
#   错误体验              未知主机返回 error + hint
```

它用 PowerShell 的 .NET 管道启动 `node mcp/server.mjs`，逐条发送 initialize / tools/list / tools/call，
与 Codex/Claude Code/OpenCode 启动 server 的方式一致（Node 版 `stdio-client.mjs` 是同一条路径，
仅在禁止 Node spawn 的环境里不可用）。

## 第 5 层：OpenCode 问答实测（已实测 4/4）

**环境**：OpenCode v2.1.4（Windows）· 模型 `opencode/deepseek-v4.1-flash-free` · 目标 `server`

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File mcp/test/opencode-e2e.ps1
# 换模型：-Model "provider/model"
```

| 用例 | 结果 | 耗时 | 证据 |
| --- | --- | --- | --- |
| 列出远程机器 | ✅ | 8s | 模型执行 `tools.presence.presence_list_hosts()`，列出 13 台机器别名 |
| 远程执行命令 | ✅ | 12s | `presence_exec` 返回 Linux 5.11.0-27-generic / x86_64 / 64 核，exit 0 |
| 读取远端文件 | ✅ | 12s | `presence_read` 返回 `/srv/app/VAE/sample.py` 前 10 行，共 148 行 |
| 错误恢复（hint） | ✅ | 23s | 读到不存在的文件后，模型引用 `hint:` 并改用 `presence_glob` 查目录 |

**OpenCode 里真实的调用形态**（它把 MCP 工具放在 `tools.presence.*` 下，通过代码执行调用）：

```
⚙ execute {"code":"const r = await tools.presence.presence_list_hosts();\nreturn r;"}
⚙ execute {"code":"... presence_exec({ host:'server', command:'uname -a && nproc' }) ..."}
⚙ execute {"code":"... presence_read({ path:'/srv/app/VAE/sample.py', offset:1, limit:10 }) ..."}
```

**Go 额度/登录排查（2026-10-25，实测解决）**

现象：OpenCode Go 订阅可用，但 CLI 一直报 `Go usage limit exceeded`，而同一个 API key 直连
`https://opencode.ai/inference/go/openai/v1/chat/completions` 返回 HTTP 200。

根因：CLI 里同时存在两个凭据时**优先使用 Console OAuth**：
- `opencode`（Console OAuth，Personal）—— 该账号的 Go 滚动窗口额度已用完
- `opencode-go`（API key）—— 可用

修法（已实测）：
1. 通过真实服务 API 创建 Go key 凭据：
   `POST /api/credential`，body
   `{"integrationID":"opencode-go","label":"Personal","activate":true,"value":{"type":"key","key":"oc_sk_..."}}`
2. 删除/停用 Console OAuth 凭据（`DELETE /api/credential/<id>`，删除前备份
   `opencode.db`），或 TUI 里 `/connect` 选 **OpenCode Go** 并粘贴 key；
3. `opencode service restart` → `opencode auth list` 只剩 `OpenCode Go Personal stored`；
4. 用 Go 模型重跑：**4/4 PASS**（8s / 10s / 14s / 17s）。

恢复 Console 登录：`opencode auth login opencode`（重新走 OAuth device 流程）。
密钥不要写进仓库或文档；本目录脚本只通过环境变量/opencode 凭据库读取。

### 实测中发现并修复的可用性问题

| 现象 | 修复 |
| --- | --- |
| 模型把目录当文件读，报 `is a directory` | 新增 **`presence_ls`** 工具（列目录：类型/大小/时间）；hint 改为"用 presence_ls/glob 列目录" |
| 模型想"原样贴出"文件，但默认输出带行号 | `presence_read` 新增 **`numbered:false`** 返回裸文本 |
| "文件不存在"提示不够具体 | hint 改为"用 presence_glob 列父目录，再读确切文件" |
| 工具分工不清 | read/ls/glob 三个工具的 description 写清：ls=目录、glob=模式、read=文件内容 |

### "好用"检查清单（实测后）

| 项 | 标准 | 结果 |
| --- | --- | --- |
| 工具发现 | `opencode mcp list` 显示 `✓ presence connected`；模型能调到 `tools.presence.*` | ✅ |
| 调用正确 | 模型主动选 `presence_list_hosts` / `presence_exec` / `presence_read`，不绕路 ssh | ✅ |
| 回答可读 | 中文回答包含真实远端信息（hostname/内核/文件内容） | ✅ |
| 延迟 | 一个回合 8–23s（含模型思考）；工具本身很快（exec 实测 15 ms） | ✅ |
| 错误可恢复 | 模型读到 `error: ... / hint: ...` 后改走 `presence_glob` | ✅ |
| 安全 | 危险命令默认 dry-run + confirm | ⚠️ 集成测试覆盖，OpenCode 回合未实测（可用 `presence_exec rm -rf` 试） |
| 长任务 | `background=true` + `presence_jobs` | ⚠️ 集成测试覆盖，OpenCode 回合未实测 |

## 故障排查

- `opencode mcp list` 里没有 presence：确认 `opencode.json` 的 `mcp.servers.presence`（2.x）结构，
  `command` 是数组、用**绝对路径**的 `node` 与 `server.mjs`；改完跑 `opencode debug config` 看合并结果。
- OpenCode 模型报 `Free usage limit reached` / `usage limit exceeded`：换 `-Model`（有额度的模型），
  或等额度重置；这不是 MCP 的问题。
- MCP server 启动失败：先跑 `node mcp/server.mjs --check`（node 版本、主机列表、环境变量）。
- 连不上某台机器：`presence_status` 看默认 host/workspace；`presence_list_hosts` 看别名与来源；
  密码认证用 `PRESENCE_PASSWORD_<ALIAS>`，别写进配置。
- 相对路径报 "needs a workspace root"：客户端配置里设 `PRESENCE_WORKSPACE=host:/abs/path`，或传绝对路径。
- ProxyJump：连接层直连 `HostName`（与插件一致）；需要跳板时让 ssh config 里目标直接可达。

## 实测记录

| 日期 | 环境 | 层级 | 结果 |
| --- | --- | --- | --- |
| 2026-10-25 | DSH 会话 / server | 1 协议冒烟 | 9/9 |
| 2026-10-25 | DSH 会话 / server | 2 真实主机端到端 | 22/22 |
| 2026-10-25 | DSH 会话 / server | 2 真实主机端到端（read_many/JSON/diff/stop 校验） | 44/44 |
| 2026-10-25 | DSH 会话 / server | 2 真实主机端到端（read_many 预算/exec script/jobs purge/forward portReleased/ls 递归/export JSON/edit 行范围） | **68/68** |
| 2026-10-25 | DSH 会话 / server | 2 真实主机端到端（0.2.0：stat/port_probe/http_probe、六种 JSON、jobs timedOut/stop port、trash 批量、edit actual/projected、write ifMatchSha256、exec 危险命令 JSON） | **97/97**（连续三轮） |
| 2026-10-25 | DSH 会话 / server | 3 真实 stdio 传输 | 5/5 |
| 2026-10-25 | OpenCode 2.1.4 + deepseek-v4.1-flash-free | 4 opencode 问答 | **4/4**（free tier 额度耗尽前） |
| 2026-10-25 | OpenCode 2.1.4 + opencode-go/deepseek-v4.1-flash（API key） | 4 opencode 问答 | **4/4**（8/10/14/17s，Go 凭据生效后） |
| 2026-10-26 | DSH 会话 / server | 2 真实主机端到端（read_many `hash`、forward `createdAt`、status `node`/`uptimeMs`） | **103/103**（连续两轮） |
| 2026-10-26 | 临时目录 `npm install presence-mcp-0.2.0.tgz` | 3 打包安装自检（self-contained） | **7/7** |
| 2026-10-26 | DSH 会话 / server | 1 协议冒烟（含 status `node`/`uptimeMs`） | 9/9 |

## 历史新增的集成断言（早期批次）

| 能力 | 断言要点 |
| --- | --- |
| `presence_read_many` 每文件上限 | `big.txt`：`readBytes === 16384`、`truncated:true`、`truncatedByTotal:false`、`sizeBytes > readBytes` |
| `presence_read_many` 可配置上限 | `maxBytesPerFile:100` → `readBytes === 100`，`sizeBytes === 2000` |
| `presence_read_many` 总量裁剪 | 4×1000 B、`maxBytesTotal:2500` → `1000,1000,500,0`，尾项 `truncatedByTotal:true` |
| `presence_read_many` 文本注记 | `… [truncated: showing 64 of N bytes]` + `total: 2 files, X bytes` |
| `presence_exec script` | 文本/JSON 两种返回；`exitCode:3`、`cwd`、`command`、`script:true`；command+script 与两者皆缺均报错 |
| background JSON | `{jobId,pid,cwd,command,logPath,label,ready,waitedMs}`，`cwd` 是解析后的工作区路径 |
| `presence_jobs` | 默认隐藏 exited、`all:true` 含历史、`purge jobId`/`all:true` 过滤、`exitSummary:"signal 143 (SIGTERM)"` |
| `presence_forward close` | `state:"closed"`、`localPort`、`portReleased:true`（文本 + JSON） |
| `presence_ls` | `recursive:true` 5 项、目录 `recursiveBytes`（8/3）、文本 `total: 3 files, 19 bytes` |
| `presence_export` | `format:"json"` 四字段 + sha256；`name` 覆盖文件名；`../nested/x` 被清洗且仍在导出目录内 |
| `presence_edit` 行范围 | `mode:"lines"`、`replaced:2`、`startLine/endLine`、diff、`dryRun` 不写、空 `newText` 删除、与 `oldText` 互斥、越界报错 |

### 0.2.0 新增（2026-10-25）

| 能力 | 断言要点 |
| --- | --- |
| `presence_stat` | 存在/缺失/目录三行；`mode:"0644"`、`sizeBytes:11`、sha256 与本地 `createHash` 一致、`mtimeISO` 以 Z 结尾；文本 `2 path(s): 1 found, 1 missing` |
| `presence_port_probe` | 后台 `http.server` 就绪后 `listening:true`、`ok:true`、`probe:"accepted"`、带 pid/process；`expect:"closed"` 对开放端口 `ok:false`；停止后 `waitMs:5000` 等到 `probe:"refused"`、`ok:true` |
| `presence_http_probe` | `/` 200 + `bodyMatched:false`、`/sub/a.txt` 200 + 12 B + `bodyMatched:true`、`pass:true`、`portReleased:true`；隧道从 `forward list` 消失；断言失败时 `pass:false`、404、`missingBody` 命中 |
| `presence_list_hosts` JSON | `address/user/port/source/state/connected/default` 字段类型；默认主机标记为 `default:true` |
| `presence_connect` JSON | 解析身份行得到 `user/hostname/kernel/arch/platform/connectedAtMs` |
| `presence_search` JSON | `{pattern,root,countOnly,matchCount,truncated,matches}`；命中 `{file,line:2,text:"gamma"}`；`countOnly` 时 `matches:[]` |
| `presence_glob` JSON | `path/sizeBytes/mtimeISO/mtimeMs`，`a.txt` 12 B |
| `presence_import` JSON | 完整 64 位 sha256、`localPath`、`sizeBytes:10`、`mode:"0644"` |
| `presence_jobs` wait/status | 运行中 `status.exitSummary === null`；`wait timeoutMs:1000` → `state:"running"`、`timedOut:true`、`exitSummary:null` |
| `presence_jobs stop port` | `port:18942` → `portReleased:true`，`alive:false`，`exitSummary` 仍可读 |
| `presence_trash` 批量 | `paths:[a1,a2]` → `results.length === 2`、`trashed:2`、每项 `sourceRemoved:true`、`sizeBytes:3`；单项缺失 → `failed:1` 且逐项 `error`；`list` 只有 `movedAtISO`（无 `movedAt`/`movedAtMs`） |
| `presence_edit` 尺寸 | dryRun：`actualSizeBytes:12`、`projectedSizeBytes:19`、`sizeBytes:12`；文本 `dry run: 12 B → 12 B projected` |
| `presence_write ifMatchSha256` | 命中时写入成功且 `sha256` 返回；不命中时报错文本同时含期望/当前哈希，文件内容不变 |
| `presence_exec` 危险命令 JSON | `dryRun:true`、`requiresConfirm:true`、`targets` 含目标目录、`report` 无 U+FFFD 且含 `nothing was executed yet`；目标目录仍在 |

### 发布收尾新增（2026-10-26）

| 能力 | 断言要点 |
| --- | --- |
| `presence_read_many` `hash:true` | 完整文件（`sub/a.txt`）`sha256` 与本地 `createHash('sha256')` 一致且 `truncated:false`；`big.txt` 被截断时 `sha256:null`；未传 `hash` 的对象**没有** `sha256` 字段；文本模式输出 `sha256: <hex>` / `sha256: null` |
| `presence_forward` `createdAt` | open 的 JSON 是 `^YYYY-MM-DDTHH:MM:SS.mmmZ$`，与 `Date.now()` 相差 < 120 s；list 里同一条隧道的 `createdAt` 与 open 完全一致 |
| `presence_status` `node`/`uptimeMs` | `node` 匹配 `^v\d+\.`，`uptimeMs` 为非负数字且小于 1 h；smoke 的 status 断言也覆盖这两个字段 |

游戏构建长任务（Canvas Space Invaders，3 阶段 / 73 次工具调用）的摩擦清单与这些改动的对应关系见
[GAME-LONGTASK.md](GAME-LONGTASK.md)；该任务独立复核为 14/14 测试、`node --check` 通过、
隧道 HTTP 200、无头 `Game` 导入成功。
