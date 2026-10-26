# 真实客户端压力测试复盘（MCP 0.1.2 → 0.2.0）

本文件记录一次**真实客户端**压力测试的结果、发现的问题，以及 0.2.0 这一轮针对这些
问题所做的改动。原始逐条记录（22 步、17 个工具、含每一步的耗时与原文返回）在
[`../.scratch/dino/tooltest-findings.md`](../.scratch/dino/tooltest-findings.md)。

## 1. 测试概况

| 项 | 值 |
| --- | --- |
| 客户端 | 真实 MCP 客户端（Dino/OpenCode 类 agent），非脚本直调 |
| 目标机 / 工作区 | `server`（Linux 5.11 / x86_64）/ `/srv/app/dino-run` |
| 步骤 | **22/22 全部执行成功** |
| 覆盖工具 | **17/17** 全部真实调用（当时版本 0.1.2） |
| 工具自身耗时 | 累计约 **7.2 s**（不含本地 shell、模型思考与网络抖动） |
| 产物 | 未改动游戏源码；只创建并清理了探针文件；回收站保留 3 个可恢复探针 |

测试按 A–L 分组：连接与信息、文件读、写入/编辑、搜索与 glob、前台/脚本/后台 exec、
端口转发 + 本地 fetch、jobs 全生命周期、交互式终端、本机 ↔ 远端传输、回收站、
危险命令保护、清理与残留确认。

## 2. 主要发现（按严重程度）

| 级别 | 发现 | 证据（来自实测） |
| --- | --- | --- |
| P0 | 结构化返回不统一：`list_hosts` 静默忽略 `format`，`search`/`glob` 只有人类可读文本，`import` 的 sha 被省略号截断，`terminal open` 只能正则解析 id | 第 1a/9/10/18/17 步 |
| P0 | 终端接口难用：open 无 `terminalId` 字段、无 `cwd`/`command`，默认落在 `/home/user`；`write` 直接吞掉输出，随后 `read` 为空 | 第 17 步 |
| P1 | `exec` 危险命令 dry-run：`format:"json"` 仍返回纯文本；报告首个分隔符是损坏字节（`nothing was executed yet` 前显示为替换字符）；无结构化 targets | 第 21 步 |
| P1 | 写入缺少并发保护；`edit` dryRun 的 `sizeBytes` 实为**预测值**（文件仍 63 B，字段却报 64） | 第 7b/8 步 |
| P2 | `jobs wait` 无 `timedOut`；运行中任务 `exitSummary:"unknown"`；`stop` 不验证端口释放；`trash` 只能单路径、`movedAt` 重复三份 | 第 16/20/22 步 |
| P2 | 端口/HTTP 验证要手工串 5 个调用：后台 exec → forward open → 本地 fetch → forward close → exec 查端口 | 第 15/22 步 |

## 3. 本轮新增的 3 个工具

### `presence_stat` — 批量路径元数据 + 哈希

一次远端 `exec` 完成 1–100 个路径的 `stat -c '%F|%s|%a|%Y|%n'`，`hash:true` 时对普通
文件追加 `sha256sum`；**缺失路径返回 `exists:false`** 而不是让整次调用失败，因此它同时
是存在性检查。`followSymlinks` 控制是否穿透符号链接。

```text
presence_stat({ paths: [...], hash: true, followSymlinks: false, format: "json" })
→ [{ path, exists, type, sizeBytes, mode, mtimeISO, mtimeMs, sha256? }]
```

替代了实测中反复出现的 `stat -c` / `sha256sum` / `test -e` 兜底。

### `presence_port_probe` — 监听端口 + TCP 探测

一次 `exec` 同时取回 `ss -ltnp` 的监听表（含 pid/process）和每个端口的 TCP 连接结果
（`bash /dev/tcp`，无 bash 时回退 `python3 -c socket`）。`expect:"open"|"closed"` 让
`ok` 直接表示"是否符合预期"，`waitMs` 每 250 ms 轮询直到满足或超时。

```text
presence_port_probe({ ports: [8010], expect: "closed", waitMs: 5000, format: "json" })
→ [{ port, listening, pid, process, probe: "accepted|refused|timeout|skipped", ok }]
```

它补上了 `jobs stop` 与 `forward close` 之外"端口真的释放了吗"的独立证据。

### `presence_http_probe` — 转发 + HTTP 断言 + 自动清理

一次调用完成：等远端端口 → `pool.openForward` → 本地 `fetch` 多个 path →
断言状态码/响应体 → **finally 里必定关闭隧道** → 探测本地端口已释放。

```text
presence_http_probe({
  remotePort: 8010, paths: ["/", "/src/main.js"],
  expectStatus: [200], expectBody: ["id=\"game\""], format: "json"
})
→ { forwardId, localPort, remotePort, results, pass, portReleased }
```

`pass` = 所有状态码都在 `expectStatus` 中 **且** 每个 `expectBody` 子串都出现在
（拼接后的）响应体里。第 15 步原本要 5 个工具调用，现在 1 个。

## 4. 格式与行为修复

| # | 工具 | 0.2.0 行为 |
| --- | --- | --- |
| 4 | `presence_list_hosts` | `format:"json"` → `[{alias,address,user,hostname,port,source,state,connected,default}]`；文本新增 `*` 标记默认主机 |
| 5 | `presence_connect` | `format:"json"` → `{host,user,hostname,kernel,arch,platform,connectedAtMs}`（解析身份行） |
| 6 | `presence_search` | `format:"json"` → `{pattern,root,countOnly,matchCount,truncated,matches:[{file,line,text}]}`；`countOnly` 只给计数 |
| 7 | `presence_glob` | `format:"json"` → `[{path,sizeBytes,mtimeISO,mtimeMs}]` |
| 8 | `presence_terminal` | 五种动作都支持 `format:"json"`；`open` 新增 `cwd`/`command`（默认 bash），返回 `{terminalId,host,cwd,shell,reused}`；`write` 新增 `ackOnly`（`{terminalId,writtenBytes,output:null}`，输出留给 `read`） |
| 9 | `presence_import` | `format:"json"` → `{remotePath,localPath,sizeBytes,sha256,mode}`，sha256 完整 |
| 10 | `presence_jobs` | `wait` 新增 `timedOut`；运行中 `status` 的 `exitSummary` 为 `null`（不再是 "unknown"）；`stop` 新增 `port`，停止后探测端口并返回 `portReleased`（文本 + JSON） |
| 11 | `presence_trash` | `trash` 支持 `paths[]`（1–50），逐项返回 `{results:[{path,trashPath,sizeBytes,sourceRemoved,restoreHint}]}`；`list` 的 JSON 只保留一个 `movedAtISO` |
| 12 | `presence_edit` | dryRun 新增 `actualSizeBytes`（磁盘现值）/`projectedSizeBytes`（编辑后）；dryRun 时 `sizeBytes` = 实际大小，写入时 = 落盘大小；文本改为 `dry run: 64 B → 63 B projected` |
| 13 | `presence_write` | 新增 `ifMatchSha256` 乐观锁：不匹配时报错并同时给出期望/当前哈希，不写文件；文本改为完整 sha256 |
| 14 | `presence_exec` + `src/destructive.js` | dry-run 在 `format:"json"` 下返回 `{dryRun,requiresConfirm,targets,command,report}`；`guardDestructive` 顺手返回 `targets`（签名兼容）；修掉报告里的损坏字节（`nothing was executed yet` 前的分隔符改成 ASCII `:`），源码现在是干净 UTF-8，无 U+FFFD |
| 15 | 版本/文档 | `package.json` + `app.mjs` 升到 **0.2.0**；`tools/list` **20** 个工具；README/TESTING 同步 |

`presence_exec` 的脚本模式（`script`）dry-run 也补上了同样的 JSON 结构
（`targets: []`，因为脚本模式无法解析具体目标）。

## 5. 验证结果

| 层级 | 命令 | 结果 |
| --- | --- | --- |
| 语法 | `node --check mcp/tools.mjs` / `mcp/test/integration.mjs` | 通过 |
| 协议冒烟 | `node mcp/test/smoke.mjs` | **9/9**，`tools/list` 20 个工具，`presence_status.tools = 20` |
| 真实主机端到端 | `node mcp/test/integration.mjs server` | **97/97**（连续三轮通过） |

本轮新增的集成断言（29 项）覆盖：

- `presence_stat`：存在/缺失/目录、`mode:"0644"`、sha256 与本地 `createHash` 一致、文本汇总行
- `presence_port_probe`：后台 `http.server` 起来后 `listening/ok/probe=accepted` 且带 pid/process；
  `expect:"closed"` 对已开放端口 `ok=false`；`waitMs` 等到停止后 `probe=refused`
- `presence_http_probe`：`/` 200、`/sub/a.txt` 200 + 12 B + `bodyMatched`、`pass:true`、
  `portReleased:true`、隧道已从 `forward list` 消失；断言失败时 `pass:false`、404 仍正确返回
- `list_hosts` / `connect` / `search`（含 countOnly）/ `glob` 的 JSON 结构与字段类型
- `presence_terminal`：open JSON（cwd = 工作区、shell=bash、reused=false）、`ackOnly` 写
  （`output:null`，输出由 `read` 取回）、list、close JSON
- `presence_import` JSON：完整 sha256、localPath、mode
- `presence_jobs`：`wait timedOut:true` 且 `exitSummary:null`；`stop port=N` → `portReleased:true`
- `presence_trash`：批量 `paths[]` 两项成功、部分失败仍逐项返回、`list` 只有 `movedAtISO`
- `presence_edit`：dryRun 的 `actualSizeBytes:12 / projectedSizeBytes:19 / sizeBytes:12` 与文本
  `dry run: 12 B → 12 B projected`
- `presence_write ifMatchSha256`：匹配时写入、不匹配时报错含双方哈希且文件未变
- `presence_exec` 危险命令 dry-run：`{dryRun:true,requiresConfirm:true,targets:[...]}`、
  报告无 U+FFFD、目标目录仍在

## 6. 兼容性说明

- **默认文本输出保持不变**：所有既有工具的文本格式未改动；只有
  `presence_edit` 的 dryRun 文本、`jobs status/wait` 的运行中 `exit:` 行、`presence_write`
  的 sha256 长度按上文有意调整。
- **一处 JSON 破坏性变更**：`presence_trash list` 不再输出 `movedAt` / `movedAtMs`，
  只保留 `movedAtISO`（这正是本轮修复的"时间重复三份"）。
- `presence_trash trash` 的单路径 JSON 形状保持不变（新增 `paths[]` 时才返回 `{results}`）。
- `guardDestructive` 只多返回一个 `targets` 字段，插件侧调用不需要改。

## 7. 本轮未做（继续保持观察）

来自同一份报告、但不在本轮范围内的建议：

- `presence_ls` 根级 `totalBytes/totalFiles`、目录 `itemCount` 语义
- `presence_read_many` 每文件 sha256/encoding、按行截断
- `presence_forward open` 返回 `createdAt`；`jobs` 返回 `startedAtISO/endedAt`
- `presence_terminal read` 的 cursor、`presence_status` 的连接延迟
- `presence_search` 上下文行、`presence_glob` 排除规则/pattern 数组
- `presence_exec` 的 `probeHost`/`bindAddr`（`waitForPort` 目前固定探测远端 `127.0.0.1`）
