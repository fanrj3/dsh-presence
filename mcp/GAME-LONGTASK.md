# Presence MCP 游戏长任务实测（Canvas Space Invaders）

在真实远程主机上用 OpenCode 连续三个阶段的会话构建一个可玩的太空侵略者游戏，记录 agent 使用
presence 工具时的真实摩擦，再把每一条摩擦落成工具改动。本文只记录可复核的事实；agent 的自述与
独立复核分开写。

- **远程项目**：`/srv/app/webgame-presence`（server，Linux 5.11 / x86_64，Node v22.23.2，
  Python 3，Firefox 136）
- **客户端**：OpenCode 2.1.4，模型 `opencode-go/deepseek-v4.1-flash`（Go API key）
- **会话**：`ses_webgame_presence`，同一个 session 内跑完三个阶段
- **任务**：Phase 1 核心逻辑 + 测试 + README；Phase 2 真正可玩的 Canvas 游戏；
  Phase 3 视觉/体验打磨
- **远程报告**：`/srv/app/webgame-presence/PROJECT_NOTES.md`（§1 完成度、§2 摩擦点、§3 改进建议）

## 三个阶段（实测）

| 阶段 | 内容 | 耗时 | 工具调用 | 关键产出 |
| --- | --- | --- | --- | --- |
| Phase 1 | 核心逻辑 + 测试 + README | **323 s**（日志首尾事件 319 s） | **19**（17 次调用 presence_*） | `src/game.js` 纯逻辑（确定性 PRNG、碰撞、分数/生命/波次/暂停）、14 个 `node:test` 用例、`index.html`/`styles.css`/`main.js`、README |
| Phase 2 | 可玩网页游戏 | **568 s**（日志首尾事件；未单独记录墙钟，约 570 s） | **21**（17 次调用 presence_*） | Canvas 渲染玩家/敌阵/双方子弹/星空、菜单/HUD/暂停、键盘+触屏、三档难度、localStorage、WebAudio、DPR/resize；8181 静态服务 |
| Phase 3 | 视觉/体验打磨 | **650 s**（日志首尾事件 637 s） | **33**（26 次调用 presence_*） | 爆炸粒子、敌人步态/浮动、暂停遮罩、结算统计、移动安全区、横竖屏、`prefers-reduced-motion`、属性规范化、8182 服务与清理 |

合计 **73 次工具调用 / 60 次触达 presence 工具**，三个阶段净耗时约 26 分钟；加上阶段之间的两次
准备间隔（39 s、129 s），同一 session 从第一条到最后一条日志共 28 分 12 秒（13:47:37Z → 14:15:49Z）。

计时口径：Phase 1 / Phase 3 用运行脚本记录的墙钟（323 s / 650 s），括号内是
`.scratch/game/phase*.json` 首尾事件的时间戳差（319 s / 637 s）；Phase 2 只有日志时间戳，
因此取 568 s，并给出约 570 s 的墙钟估计。工具调用数来自各 phase 日志中的 `tool_use` 事件
（OpenCode 的每次 `execute` 计一次，单次 execute 内可能调用多个 presence 工具）。

## 独立复核（本轮重跑）

不采信 agent 自述，直接连 `server` 重跑关键检查（2026-10-25）：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 逻辑测试 | `cd /srv/app/webgame-presence && node --test test/` | **14 pass / 0 fail**（14 tests，163.8 ms） |
| 语法 | `node --check src/game.js && node --check src/main.js` | exit 0 |
| 无头导入 | `node -e 'import("./src/game.js").then(...)'` | `Game` 可导入、构造、`update()` 60 帧，exit 0 |
| 静态服务 + 隧道 | `python3 -m http.server 8188` + Presence forward | `waitForPort` 17 ms ready；`GET /` **200**（含 `id="game"`）、`/src/main.js` **200**、`/styles.css` **200** |
| 收尾 | `ss -ltn` / `pgrep` / `du -sh` | 无 818x 监听、无残留 `http.server`、无 `presence-exec-*.sh`；9 个文件 / 128 K |

说明：Firefox 136 无头截图（桌面、390px 竖屏、844×390 横屏）由该任务自述并留下截图；本轮复核
的是上表中的可脚本化项。音效听感、真实手机触屏、系统级 reduced-motion 切换仍未验证（远程报告
§1「验证边界」如实标注）。

## 真实摩擦（PROJECT_NOTES §2）与修复映射

严重度按远程报告原文排序；"证据"是报告里引用的真实调用/返回。

| # | 严重度 | 摩擦（证据摘要） | 本轮改动 | 验证 |
| --- | --- | --- | --- | --- |
| 1 | 高 | **工具目录中途消失**：Phase 3 开始提示 `Instructions for the following MCP servers are no longer available: presence`，`search({namespace:"presence",limit:50})` 连续返回 `{items:[],remaining:0}`，上一轮同名工具却可用 | **不在本层**：这是客户端 catalog/工具发现层，MCP server 无法自证"我还活着"；未改 | 无（见「未解决」） |
| 2 | 高 | **`presence_read_many` 32 KiB 总上限**：一次读 6 个文件时 `main.js`（25.8 KiB）、`game.js`、测试、`styles.css` 全部 `truncated:true`，跨文件审查被迫改 5–6 次分段读取 | 每文件 `maxBytesPerFile`（默认 16 KiB）+ 总量 `maxBytesTotal`（默认 256 KiB）；逐文件 `truncated`、总量只裁尾部并标 `truncatedByTotal`；JSON 增加 `readBytes`/`truncatedByTotal`；文本增加 `… [truncated: showing X of Y bytes]` 与 `total:` 注记 | 集成 4 项：默认 16 KiB、可配置 100 B、4×1000 B/2500 B → `1000,1000,500,0`、文本注记 |
| 3 | 高 | **`presence_exec` 多层引号地狱**：`node --input-type=module -e "..."` 里再嵌正则、单引号、`getElementById\("...` 与 JSON，出现多层 `\\\"`，易静默变形 | 新增 `script` 参数：脚本写到 `/tmp/presence-exec-<random>.sh`（0700），用 `bash`（无则 `/bin/sh`）执行，`cwd` 生效，结束后（含失败/拒绝）`finally` 删除；与 `command` 互斥、二者皆缺报错 | 集成 4 项：文本、JSON（exit 3 + `cwd`/`command`/`script:true`）、互斥、缺参 |
| 4 | 中 | **后台启动返回 `cwd:null`**：`background:true` 的响应里 `jobId`/`pid`/`ready` 都对，但 `cwd` 是 `null`，无法证明服务在哪个目录启动 | `presence_exec` 的 background + `format:"json"` 改为结构化 `{jobId,pid,cwd,command,logPath,label,ready?,waitedMs?}`，`cwd` 取解析后的真实目录（不再 null）；前台 JSON 同样补 `cwd`/`command` | 集成 1 项：`cwd === remoteRoot`、`ready:true`、`waitedMs` 为数字 |
| 5 | 中 | **`presence_jobs` 无法清除已退出记录**：`stop j1` 后 `list` 永久显示 `j1 / state:"exited"`，没有 purge/clear/delete；`stop` 只有 `exitSignal:143`，无统一 exit 摘要 | `list` 默认隐藏 `exited`，`all:true` 看历史；新增 `action:"purge"`（进程内 Set 过滤列表，`{purged:[...]}`，明确不加删远端命名空间）；`stop` 文本/JSON 均含 `exitSummary`（如 `signal 143 (SIGTERM)`） | 集成 6 项：默认隐藏、`all` 含历史、purge 单个、purge 全部、`exitSummary`、原 stop 校验 |
| 6 | 中 | **`presence_forward close` 信息不足**：只返回 `{id:"f2",closed:true}`，还要 `ss -ltnp` + 本地 `fetch` + `forward list` 三重确认端口释放 | close 返回 `state:"closed"`、`localPort`、`portReleased`（关闭后真实 TCP 探测 `127.0.0.1:<localPort>`，约 500 ms，必要时重试一次）；文本同样带 `released: yes/no`；`list` 保持只列 `state:"open"` 并带 `url` | 集成 2 项：JSON 三字段 + 文本 `released: yes` |
| 7 | 低 | **`presence_ls` 不递归、目录 `sizeBytes` 误导**：根目录 `src: sizeBytes 48`、`test: 55` 是目录项自身大小，不是内容总量；结构要分别 ls 三次 | `recursive:true`（深度 6、跟随目录、上限 2000 项）、`totalBytes:true`（只统计文件）；JSON 增加 `isDir`、`depth`/`relPath`，目录在请求时给 `recursiveBytes`；文本末尾 `total: N files, X bytes` | 集成 2 项：递归 JSON（`sub.recursiveBytes===8`、`deep===3`、5 项）、文本 `total: 3 files, 19 bytes` |
| 8 | 低 | **`presence_export` 只回句子、文件名带哈希前缀**：`downloaded /tmp/phase3-desktop.png → C:\...\211a4a9f402d-phase3-desktop.png ...`，多张截图只能手工按哈希匹配 | `format:"json"` → `{remotePath, localPath, sizeBytes, sha256}`；新增 `name` 覆盖本地文件名（清洗路径分隔符与 `..`，仍限制在导出目录内）；文本保持不变 | 集成 2 项：JSON + name 字节一致；`../nested/renamed.bin` → 目录内 `renamed.bin` |
| 9 | 低 | **`presence_edit` 只支持精确长锚点**：模板字面量/多行块要构造很长 `oldText`，空白一变就失效；本轮 20+ 次编辑都成功但大块重构希望行号范围/patch | 新增 `startLine`/`endLine`（1-based，含端点）+ `newText`：整段替换（`""` 删除整段），与 `oldText` 互斥；返回同一套 diff/JSON，`replaced` 为替换行数、`mode:"lines"`；`dryRun` 可用；写入走原子 `writeText` 并保留原 mode | 集成 6 项：替换、`dryRun` 不写、空 `newText` 删除、互斥、越界、diff/mode/replaced |

## 修复后的回归验证

- `node --check mcp/tools.mjs` → 通过
- `node mcp/test/smoke.mjs` → **9/9**（17 个工具、schema/注解不变）
- `node mcp/test/integration.mjs server` → **68/68**（本轮之前 44/44）
- 新增断言覆盖上表第 2–9 条；第 1 条（工具发现层）无法在 MCP server 内测试

## 未解决 / 边界

1. **工具目录消失**（摩擦 #1）是 OpenCode 的 catalog 行为，MCP server 只能保证被调用时正常工作；
   远程报告建议的"`search` 返回带 `server`/`error` 的占位项、`presence_status` 显示 catalog 健康度"
   属于客户端/工具发现层，本轮未做（`presence_status` 只新增了 `purgedJobs`）。
2. **未在改完后重跑一次 OpenCode 游戏任务**：客户端实测需要普通 PowerShell（DSH sandbox 禁止
   Node 子进程管道）和模型额度；本轮以真实主机集成测试验证每条新选项，而不是再做一次端到端 agent 回合。
3. `presence_jobs purge` 只过滤 MCP 进程内的列表，远端 job 注册表/日志仍在；进程重启后历史会重新出现。
4. `presence_read_many` 默认输出上限约 256 KiB 正文，是按"不再无故截断"设计的；上下文紧张时应显式调小
   `maxBytesTotal` / `maxBytesPerFile`。
5. `presence_exec script` 的破坏性检测只做文本模式匹配（无法像 command 模式那样解析具体目标），
   命中时要求 `confirm:true`。

## 参考

- 远程报告：`/srv/app/webgame-presence/PROJECT_NOTES.md`
- 阶段日志：`.scratch/game/phase1.json`、`phase2.json`、`phase3.json`（本机 scratch，不随包发布）
- 工具实现：`mcp/tools.mjs`；集成断言：`mcp/test/integration.mjs`；结果：`mcp/TESTING.md`

## Phase 4：MCP 0.1.1/0.1.2 新能力实测（同一 OpenCode 会话）

用新版 MCP 对同一个游戏项目做一次针对性验证（18 次工具调用、0 错误、490 s）：

| 能力 | 实测结果 |
| --- | --- |
| `presence_read_many` + `maxBytesPerFile/maxBytesTotal` | main.js/game.js 各读 8000 B，`truncatedByTotal:false`，不再互相挤占 |
| `presence_exec script` | Node 脚本走临时文件执行，cwd/exitCode/stdout 正确，无引号地狱 |
| `presence_jobs list/purge` | 默认隐藏 exited；purge 后 `all:true` 为空 |
| `presence_forward close` | 返回 `state:"closed"`、`portReleased:true`，本地随后 ECONNREFUSED |
| `presence_ls recursive/totalBytes` | 9 文件、103,548 B；`src` recursiveBytes 46,968 |
| `presence_export format:json` | localPath/sizeBytes/sha256 结构化，sha256 与服务器一致 |
| `presence_edit startLine/endLine` | 行号替换 + diff 正常；README 临时改动已还原 |

**Phase 4 之后补的残留**（0.1.2）：

1. `presence_jobs` 的 `start`/`wait` 也支持 `format:"json"`（返回 id/pid/cwd/状态，不再需要从文本抠 jobId）；
2. `presence_edit` 文本/JSON 增加 `bytesBefore/bytesAfter`；
3. `presence_status` 增加 MCP 版本号（直接确认 0.1.2）；
4. 仍残留：`presence_ls` 根目录无聚合总字节字段（需按文件求和）；opencode 工具目录偶发短暂空缺是客户端行为；
5. 插件侧同名工具体验已在 0.17.4 同步修复（见 `docs/VERIFICATION.md`）。

验证：smoke 9/9、integration 68/68、`node --check` 通过。
