# Presence MCP 长程任务实测（OpenCode + Go 模型）

用真实的 OpenCode 2.1.4（模型 `opencode-go/deepseek-v4.1-flash`）在远程主机 `server` 上完成一个多轮任务，
记录工具使用中的摩擦点，再据此改工具。本文记录实验设计、结果、摩擦清单和改进映射。

## 实验设计

远程项目 `/srv/app/longtask-presence`（由 `.scratch/seed-longtask.mjs` 生成）：

```
README.md          规格：只统计小写 .png、跳过隐藏文件/目录、bytes 为这些文件大小之和
scan.py            故意写错的实现（统计所有文件）
test_scan.py       编码正确规格的单元测试（初始失败）
data/a.png 100B    data/b.png 200B    data/sub/c.png 300B
data/.hidden/h.png 400B（应跳过）     data/notes.txt（应跳过）    data/UPPER.PNG 500B（应跳过）
```

初始状态：`python3 -m unittest -v` 失败（`{'count': 6, 'bytes': 1509} != {'count': 3, 'bytes': 600}`）。

三轮会话（同一个 OpenCode session）：

1. **第一轮**：读项目 → 复现失败 → 修 `scan.py` → 跑测试 → 生成 `report.json`。
2. **第二轮**：后台起 `python3 -m http.server 8123` → 端口转发到本地 → 本地 fetch 验证 200 与内容 →
   停止转发/服务 → 把 `report.json` 移入回收站并确认。
3. **第三轮**：让 OpenCode 自己把"工具摩擦点"写成 `feedback.md`（按严重程度、附真实参数/返回引文）。

## 结果（客观部分由我独立复核）

| 轮次 | 耗时 | presence 调用 | 结果 |
| --- | --- | --- | --- |
| 1 | 29s | 8 次（connect×2、status、read、exec×2、edit×2） | 测试通过、`report.json = {"count":3,"bytes":600}` ✅ |
| 2 | 24s | 6 次（exec×2、forward×2、jobs、trash） | HTTP 200 验证通过；无残留监听/进程；`report.json` 已在回收站 ✅ |
| 3 | 58s | 40+ 次（含多次 read/edit 写反馈文件） | 产出 `feedback.md`（约 9.9 KiB，8 条摩擦 + 做得好的部分）✅ |

独立复核：直接连 `server` 检查 `report.json` 内容、`unittest` 退出码、`ss -ltn` 无 8123、
`pgrep` 无 http.server、`listTrash()` 含 `report.json`。

## OpenCode 报告的真实摩擦点（摘要）

按反馈的严重程度重排：

### P0-2 返回内容混入元数据，无法机器消费
- `presence_read number:false` 仍追加 `(N lines total)`，污染精确匹配/逐字节核对；
- `presence_exec` 把 stdout/stderr/exitCode/耗时包成一段文本（`$ cmd`、`[stderr]`、`(exit=… · … ms)`）；
- `presence_ls` 返回人类可读尺寸与本地化时间，脚本要二次解析。

### P0-3 缺少批量/原子能力
- 读 3 个文件 = 3 次 `presence_read`；`edit` 后要回读；
- 生成 JSON 文件被迫用 `... > report.json && cat report.json` 绕开输出包装。

### P1-1 后台任务 / 端口转发可观测性差
- `background:true` 只回 job id/pid，没有 ready 信号，还要再 `ss` 探测；
- `forward open` 只回 `opened forward f2`，`list` 是纯文本；
- `jobs list` 是制表符文本、`stop` 只回 `stopped=true`，还要自己 `ps/ss/tail` 确认。

### P1-2 回收站语义含糊
- `trashed … (27 B, copy)` 中的 `copy` 让人不知道源文件是否已删；
- `list` 跨项目、无过滤、时间显示异常（ISO 字符串被当毫秒格式化）。

### P2-1 `presence_edit` 没有 diff
- 只能自己回读文件确认改了什么，多一次调用。

### P2-2 `presence_status` 的默认 cwd 表述含糊
- `defaultCwd: null` 与文档"exec 默认使用 workspace 目录"读起来矛盾。

### P2-3 `presence_write` 的 mode 回显误导
- 返回 `mode 0`，实际是 `644`；`9.2 KiB` 与字节数口径不一致。

### 做得好的（反馈原文）
- `presence_connect` 一次拿到身份行；
- `presence_exec` stderr 原样透传，unittest 失败栈可行动；
- `presence_edit` 默认拒绝多处匹配；
- 后台启动一条命令拿到 job id/pid/日志；
- 输出里的 `(cwd: ...)` / `(exit=N · X ms)` 对人工排查有用。

## 改进映射

| 摩擦点 | 改动 |
| --- | --- |
| P0-2 | `presence_read` 增加 `raw:true`（不编号、不加 trailer）；`presence_exec` 增加 `format:"json"`；`presence_ls` 增加 `format:"json"`（`sizeBytes`/`mtimeISO`） |
| P0-3 | 新增 `presence_read_many`（一次读 1–50 个文件，支持 `raw`/`format:"json"`）；`presence_exec` 增加 `saveStdout`（直接把 stdout 落到远程文件） |
| P1-1 | `presence_exec background` 增加 `waitForPort`（直接返回 ready/等待结果）；`presence_forward` 支持 `format:"json"`（结构化 id/端口/url/state）；`presence_jobs` 增加 `status`、`format:"json"`，`stop` 带存活复核 |
| P1-2 | `presence_trash` 支持 `format:"json"`，`trash` 返回 `sourceRemoved`/`restoreHint`/`sizeBytes`；`list` 修复时间解析、支持 `path` 过滤、按时间倒序 |
| P2-1 | `presence_edit` 增加 `dryRun` 与 diff 返回（文本 + `format:"json"`） |
| P2-2 | `presence_status` 增加 `effective: {host, cwd}` 与说明 |
| P2-3 | `presence_write` 返回真实 `mode`（如 `0644`）、`sizeBytes`、`sha256` |

## 改进后的回归验证（第四轮，2026-10-25）

**环境**：OpenCode 2.1.4 + `opencode-go/deepseek-v4.1-flash`，新会话 `ses_longtask_v2`，MCP 用
`--standalone` 从文件重新拉起（关键：opencode 后台服务会缓存 MCP 进程，改完代码必须
`opencode service restart` 或 `--standalone`）。

**结果**：22 次工具调用、0 个错误事件、116 秒；README 未被 dryRun 修改（520 B/644），
verify.txt 已进回收站，8124 无监听/无残留进程（独立复核）。

| 旧摩擦点 | 实测现状 | 结论 |
| --- | --- | --- |
| P0-2 返回混元数据 | `read raw` 无尾注；`exec format:json` 直接给 `stdout/stderr/exitCode/durationMs`；`ls format:json` 给 `sizeBytes/mtimeISO` | ✅ 已解决 |
| P0-3 缺批量 | `presence_read_many` 一次读 3 个文件；`exec saveStdout` 可用 | ⚠️ 部分解决（edit 批量、统一 batch 仍缺） |
| P1-1 后台/转发不可观测 | `waitForPort` 16 ms 返回 ready；forward/jobs 结构化；`stop` 带 `alive/verified/survivors` | ✅ 基本解决（forward id 仍跨会话累计） |
| P1-2 回收站语义 | `sourceRemoved:true` + `restoreHint` + `sizeBytes`；list 支持过滤/JSON/时间倒序 | ✅ 基本解决（list 条目缺原始路径） |
| P2-1 edit 无 diff | 返回 ±2 行上下文 diff；`dryRun:true` 不落盘 | ✅ 已解决（`sizeBytes` 语义待澄清） |
| P2-3 write mode 误导 | 返回 `mode:"0644"`、`modeNumeric`、`sha256`，与远端 `stat/sha256sum` 一致 | ✅ 已解决 |

**第四轮新发现（按严重度）**

1. **缓存陷阱**：第一次跑第四轮时 opencode 复用旧 MCP 进程，新参数被静默丢弃（`dryRun` 甚至真的写入，已还原）。
   文档需明确：改完 MCP 代码要 `opencode service restart` 或 `--standalone`。
2. `forward` id 跨会话累计（本轮首个 open 是 `f3`），建议按会话加前缀或返回 `session`。
3. `jobs stop` 只有 `exitSignal:143`、`exitCode:null`，建议补统一 `exit` 摘要字段。
4. `edit dryRun` 的 `sizeBytes` 是“改后大小”，建议 `bytesBefore/bytesAfter`。
5. `trash list` 条目缺原始路径与逐条 `restoreHint`；`ls` 的目录 `sizeBytes` 是目录项本身大小（易误解）。
6. `read_many raw` 会插入 `=== path ===` 分段标题（文本模式预期，JSON 模式无此问题）。

**调用次数对比**：前两轮任务 ~14 次 presence 调用；第四轮验证 22 次（内容更多，但 friction 明显下降：
不再手工剥 JSON 包装、不再手写 ss 轮询、不再回读 edit、不再手工拼 sha256）。

**下一步（未做）**：edit 批量/统一 batch 工具、forward 会话隔离、jobs 统一 exit 摘要、
trash list 原始路径、ls 目录大小语义。

