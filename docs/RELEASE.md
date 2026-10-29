# Presence 发布说明（Release）

## v0.20.0 — hotfix + P1 batch

安全热修 + P1 批次：本地会话不再静默借用远端工作区；新增条件等待原语 `presence_wait`；
后台任务持久化；批量导入/导出与追加写；读后写状态修正；文档与系统提示。

### 安全热修：会话不再静默解析到远端工作区
- 症状（真实事故）：本地会话（cwd 在本地，如 `D:\02_Research\...`）调用 `presence_exec`
  未带 host 时，会解析到**全局最后激活**的远端工作区（`workspaces.json` active=`lthpc-v6:/nas4/Tent`），
  命令在错误的机器上、以错误的 cwd 执行。
- 现在的解析顺序：会话 cwd 在挂载目录内 → 用挂载主机；显式 `host` → 用它；配置 `PRESENCE_HOST`
  → 用它；否则**报错**（提示 `this session is local (cwd=...); pass an explicit host ...`）。
  绝不回退到全局 active workspace。
- `presence_hosts` 的 `default` 同样会话作用域（`sessionWorkspaceHost ?? PRESENCE_HOST`），
  `workspace: true` 只标记本会话的挂载主机。
- 系统提示改为按会话作用域：静态文本给出 (a) 远程工作区 / (b) 本地 两条明确规则，不再有
  "如果 cwd 在挂载根下……"这种含糊条件；另外新增 per-agent 动态小节 `presence:session-scope`
  （`agent/created` 时解析 cwd，本地会话直接看到 `This session is LOCAL (cwd=...)`，随 agent 释放）。
- `presence_exec` 文本头改为 `host: <alias>  remote cwd: <abs>`，前台/后台报告一致；工具描述同步。

### presence_wait 条件原语（第 25 个工具）
- 条件（五选一）：`file`（`exists`/`minBytes`/`mtimeAfter`）、`grep`（`pattern`/`count`）、
  `process`（`pid`/`pattern`/`alive`）、`port`（`open`/`closed`）、`job`（`jobId`）。
- 返回 `{ met, timedOut, elapsedMs, observed, condition }`；**超时返回 `met:false`，不抛错**。
- 选项：`timeoutMs` 默认 120000（上限 3600000），`pollMs`/`intervalMs` 默认 1000；每次轮询只发一个
  有界远端调用（stat/grep/ps/connect）。
- 取代 agent 手写的 sleep + tail 轮询循环。

### 后台任务持久化 + 可信状态
- 新增 `src/job-store.js`：`~/.dsh/presence/jobs.json`（`PRESENCE_JOBS_FILE` 可覆盖），原子写，
  损坏文件备份后重置。
- 任务记录跨 DSH 重启可见；启动时读入的记录状态为 `unknown`（不是 `running`），直到 pid 探活
  成功；记录 `pid`/`pgid`/`exitCode`/`exitSignal`/`startedAt`/`exitedAt`，重启后退出码可能缺失。
- 日志：`logPath` 是要 tail 的任务日志（当前内核里就是命令的 stdout/stderr）；`commandLogPath` 是
  命令自己的日志，当前内核下等于 `logPath`（只有内核提供独立包装日志时才不同），请用
  `commandLogPath ?? logPath`。
- 后台启动保持 `setsid` 脱离，SSH 断开不影响任务。
- `/state` 的 jobs 增加 `pid`、`pgid`、`commandLogPath`、`persisted`。

### 批量传输与追加写
- `presence_import`：新增 `paths[]`（1–50）和/或本地 `glob`（相对本地 cwd）+ `to` 目录，逐文件返回结果；
  单文件行为不变。
- `presence_export`：新增 `paths[]` 或远端 `glob`；默认本地文件名 = basename，重名冲突变成
  `name-<sha8>.ext`；逐文件返回 `{remotePath, localPath, bytes, sha256}`；单文件行为不变。
- `presence_write` 新增 `mode:"overwrite"|"append"`（默认 overwrite）：append 读取当前大小后在 EOF 追加，
  返回追加字节数、总大小、sha256；`ifMatchSha256` 只在 overwrite 下有效，append 传入会直接报错；
  `mode` 仍接受八进制权限字符串（如 `"755"`，仅 overwrite）。

### 读后写状态（guard）
- 路径 key 归一化：`presence://host/path`、挂载路径、工作区相对路径、远端绝对路径映射到同一个
  canonical key；保留 legacy key。
- `presence_read`/`presence_write`/`presence_edit` 成功都会发布 `fs/observed` 并记账（写也算已读），
  后续内置 `edit` 可通过守卫。
- 限制：`presence_exec` 的 `cat file` 无法回填守卫状态，**不计为已读** —— 文档写明。

### 文档 / UI
- README / README.zh-CN：本地 vs 远程会话警告（顶部 + Known limits）、`presence_wait`、任务持久化与
  `commandLogPath`、批量/追加示例、读后写 guard 限制、工具表 25 个（移除从未注册的过时 `presence_ls` 行）、
  长时间任务 recipe 扩展、安装/开发版本号 0.20.0。
- `index.js` 系统提示：会话作用域分支 + hotfix 措辞（backend owner 实现）。
- 设置页无新增 UI。

### 验证
- `p1-docs-probe` 51/51（README/zh/RELEASE 锚点、工具表 25、版本号、双语同步、hotfix 警告与
  `commandLogPath ?? logPath` 语义，无网络）。
- `p1-backend-probe`、`p1-tools-probe`、`tool-probe`、`regression`、`api-probe` 由对应 owner 运行；
  `build-client` 只在客户端改动时执行（本批无 UI 改动）。（verification counts 由 Lead 整合时补齐）

## v0.19.0 — P0 batch

P0 反馈整批修复（工具面、输出卫生、超时语义、长任务指引、危险命令分段、连接状态可信度、文档），
面向 agent 长时间、非交互使用的真实轨迹。

### 工具面：参数别名 + 错误可读性
- 所有路径工具接受 `path` / `file_path` / `filePath`；`presence_edit` 接受
  `old` / `oldString`、`new` / `newString`、`replaceAll` / `replace_all`、`dryRun` / `dry_run`；
  `presence_exec` 接受 `cwd` / `workdir` / `dir`。schema 仍只记录规范名。
- 缺参数错误带工具名、收到的键、可用别名和一行示例（`missing "path" on presence_write
  (accepted: path, file_path). Example: ...`）。
- `presence_edit` 锚点找不到时给出最近的 3 行，并提示重读 / `ifMatchSha256`。
- `presence_jobs list` 命令截断到 200 字符、label 先行。

### 输出卫生（presence_exec）
- 新增 `progress`（`last` | `all` | `strip`，默认 `last`）：`\r` 进度条只留每行最后状态，
  不再把整条进度折线塞进上下文。
- 超长输出**总是**落盘 `/tmp/presence-exec-<rand>.log` 并返回 `stdoutFile` / `stderrFile`
  （落盘失败带 `stdoutFileError` 并重试一次），文本报告以 `cwd:` 开头、带文件路径和字节数。
- 截断提示给出 `… (N characters omitted; full stdout: <path>)`（修掉旧的乱码字面量）。
- 新增 `tailLines`（0–5000）：长报告保留前 40% + 最后 N 行。
- `nohup` / 结尾 `&` / `tmux new-session` 检测：文本前置一行 `hint:`，JSON 带 `hints: []`；
  超时文本追加「后台子进程可能仍在运行」提示。

### 超时语义 + 部分输出
- `presence_exec` 超时默认 120 s → **300 s**。
- 超时返回 `timedOut: true`、`killed: true`、`killSequence: ['SIGTERM','SIGKILL']`
  （无远程 `timeout` 包装器时为 `['channel-close']`），并保留 kill 之前捕获的部分 stdout/stderr
  （超限同样落盘）；文本明确「远程进程树已终止（SIGTERM，5 秒后 SIGKILL），下面是部分输出」。
- 退出码 141 / SIGPIPE 标记 `sigpipe: true`，文本显示为「下游提前关闭，通常无害」。

### 危险命令 dry-run 分段（confirm:"partial"）
- 顶层按 `;`、`&&`、`||`、换行拆分（引号 / `$(...)` 内不拆），拒绝报告以
  `Nothing was executed — the whole command was skipped, including non-destructive parts.`
  开头，并列出 `Safe segments you can run separately:`（没有则 `(none)`）。
- `confirm:true` 执行整条命令；**新增** `confirm:"partial"` 只执行安全分段并报告跳过了哪些分段；
  `presence_trash` 仍是工作区内删除的首选。
- 工作区内单文件字面量 `rm -f <路径>` 免检（不可能删树）；路径先解析符号链接，逃出工作区照旧拦截。
- 修正 dry-run 会真的执行 `shred` / `truncate` / `mkfs` / `dd of=` / `:>` 的问题：这类命令现在只报告、
  不重放。

### 连接状态可信度
- 连接池对 `dns` / `refused` / `timeout` / `channel` / `closed` / `econnreset` 自动重试（2 次，
  200 ms / 600 ms），先替换死连接；`auth` / `permission` / `unknown host` 立即失败。
- `pool.hostState(alias)` 增加 `state`（`connected` / `degraded` / `idle` / `error`）、`lastError`、
  `lastErrorAt`、`retries`；`degraded` = 最近 60 s 内失败过、但随后连接成功或缓存连接仍可用。
- `presence_hosts` 把**当前会话工作区所在机器**标为 `default`（并加 `workspace: true`），
  `degraded` 渲染为 `degraded (last error: ...)`。
- 设置页主机卡片显示 `⚠ 降级`，tooltip 是最后一次错误；正常时仍显示 `已连接`。

### 文档 + 系统提示
- `index.js` 的 `presence:remote-machines` 系统提示追加 5 条紧凑指引：路径→工具、长任务、
  输出、危险命令、主机状态。
- `README.md` / `README.zh-CN.md`：更新 `presence_exec`（300 s、`progress`、输出落盘、`tailLines`、
  `confirm:"partial"`），新增「路径与工具怎么选」「长时间任务」两节，补充已知边界
  （登录节点清理风险、别名、后台任务不跨重启）。
- 新增探针：`scripts/p0-transport-probe.mjs`、`scripts/p0-surface-probe.mjs`、
  `scripts/p0-guard-probe.mjs`（无需真机）。

### 验证
- `p0-guard-probe` 68/68、`safety-probe` 24/24、`api-probe` 27/27；`build-client` 重建 `client.js`；
  patch 校验（Electron-as-Node）通过。
- `p0-transport-probe` / `p0-surface-probe` 及既有 `regression` / `tool-probe` 由对应 owner 在
  同一批次运行。

## v0.18.0 — 2026-10-27

### 预构建 tarball（市场一键安装）

- 已把 `npm pack` 产物以**稳定文件名** `presence-plugin.tgz`（0.18.0，约 730 KB）挂到本 Release：
  `https://github.com/fanrj3/dsh-presence/releases/latest/download/presence-plugin.tgz`
- awesome 条目补充 `tarball:` 字段（PR：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/9808 ）；
  合并且站点重建后，market / Discover 会优先用预构建包安装，免源码构建与 `allowBuilds` 授权。
- 以后发版：`npm pack` → 改名 `presence-plugin.tgz` → 覆盖同一 Release/最新 Release 的同名 asset 即可，条目无需再改。


功能版：远程文件操作、diff/日志、远端 `@` 补全、端口持久化与发现、任务通知。

### 新增能力
- **文件操作**：`presence_mkdir` / `presence_move` / `presence_copy` / `presence_chmod`；右侧「远程文件」右键菜单（新建目录、重命名、复制路径、改权限、回收站删除）。
- **远程 diff**：`presence_diff` 支持远端↔远端、远端↔本地，统一 diff + JSON 统计；面板内 diff 视图。
- **日志跟随**：`presence_tail`（一次性 tail / 限时 follow）；面板「查看日志」自动刷新。
- **任务通知**：后台任务结束触发 toast/桌面通知；可选 `notifyCommand` 本地命令（`PRESENCE_JOB_*` 环境变量）。
- **`@` 远端补全**：远程工作区里 file-reference 补全直接索引目标机（`rg --files`/`find`，约 10 秒缓存），不再停留在空挂载目录。
- **转发持久化**：保存转发预设，连接重建时自动恢复；面板「自动恢复」开关与预设列表。
- **端口发现**：端口面板打开时扫描远端监听端口，发现新端口一键转发。
- 工具数 18 → 24；`/presence/api/state` 增加 jobs，供客户端检测任务完成。

### 兼容性修复（0.17.8 内容，本次一并发版）
- 包名统一为 `@rjfan/dsh-presence`（scoped）：profile 依赖、`cordis.patch.yml` insert、客户端注册 id 全部对齐；
- `exports` 导出 `./package.json`，修复 DSH 读取插件元信息（icon）失败导致插件不激活的问题。

### 验证
- `path-ops-probe` 23/23、`tail-diff-probe` 23/23、`infra-probe` 54/54、`regression` 7/7、`tool-probe` 32/32、`api-probe` 27/27、`job-probe` 6/6、`import-probe` 3/3、`safety-probe` 24/24、`tunnel-crash-probe` 5/5、`feature-probe` 14/14（修正为自建 fixture）。
- `embed-shell --check` 通过；`package.ps1` 重建 `client.js` 并打包。

## v0.17.3 — 2026-10-25

修复 host 进程崩溃 + 手动添加主机表单重做。

### 崩溃修复（致命）
症状：DSH host 以 exit code 1 退出，桌面端提示「应用无法启动或已意外停止」；日志里是
`Error: Not connected at Client.forwardOut ... connection.mjs:1115`。

根因：端口转发的本地监听器调用 `ssh2.forwardOut` 时，SSH 连接已断，ssh2 **同步抛异常**（不走 callback），
异常从 Node 的 `createServer` 连接回调冒泡成 `uncaughtException`，host 进程被终止。
而 `disconnect(host)`、空闲回收都不清理该主机的转发，于是"SSH 已断、本地端口还在监听"，任何访问都会引爆。

修复：
- `tunnel()` 用 try/catch 包住 `forwardOut`，断线时只销毁本地 socket，不再冒泡；
- 每条连接记住自己的隧道，`client.on('close')` 时全部关闭；
- `pool.disconnect(host)` 关闭该主机的所有转发；空闲回收遇到有活跃转发的 host 直接跳过；
- 新增 `scripts/tunnel-crash-probe.mjs`（假 client 的 `forwardOut` 同步 throw + 真 net 连接），无真机可跑。

### 体验
- 手动添加主机表单改紧凑：单行等宽命令输入框（不再被 flex 撑成 200+px 高的大框）、别名/备注并排带标签、按钮右下。

## v0.17.2 — 2026-10-25

发布准备版本（功能与 0.17.1 一致）：仓库开源（MIT）、元数据补全，便于插件市场收录。

- MIT LICENSE；`package.json` 增加 `license` / `repository` / `bugs` / `homepage` / `keywords`
- peerDependencies 改成显式预发布分支 `>=0.0.1-rc.1 <0.2.0 || >=0.2.1-rc.1 <0.3.0-0`，
  避免静默排除 harness 的 `0.2.x-rc.*` 构建（awesome-dsh-plugin 收录指南的要求）
- 新增市场图标 `assets/icon-180.png`（GitHub 托管位图）与 `screenshots.json`
- README 顶部增加徽章、MCP 说明与封面截图

产物：[presence-plugin-0.17.2.zip](../dist/presence-plugin-0.17.2.zip) ·
`dsh-presence-0.17.2.tgz`（npm pack，附在 GitHub Release）

## v0.17.1 — 2026-10-25

产物：[`dist/presence-plugin-0.17.1.zip`](../dist/presence-plugin-0.17.1.zip) · SHA-256 `3ac6d54bc967f3e464dad5532b5de9ae4b7c212c2f389bc232fb67e198db8cfb` · 1.10 MB

### 这个版本能做什么

- **把 `~/.ssh/config` 里的机器变成"本地工作区"**：持久 SSH 连接（单次调用 13–49 ms，对比 `ssh host true` 约 560 ms），远端**零安装**。
- **12+ 个 agent 工具**：`presence_exec` / `presence_read` / `presence_write` / `presence_edit` / `presence_search` / `presence_glob` / `presence_import` / `presence_export` / `presence_jobs` / `presence_forward` / `presence_terminal` / `presence_trash`。
- **内置 `read`/`write`/`edit` 直接落到远端**：通过 `dsh-presence/fs` provider 接管，agent 以为自己在本地。
- **右侧栏「远程文件」**：拖拽上传 / 下载文件夹（真实目录树）、CodeMirror 6 代码预览（行号/折叠/高亮）、图片/视频/音频/PDF 预览、密码弹框。
- **右侧栏「端口转发」**：按机器列出转发，本地端口默认与远程同号，占用时自动回退；↗ 打开 / 复制 / 停止。
- **手动主机**：不在 `~/.ssh/config` 里的机器，粘一条 `ssh ...` 命令即可（`-p/-i/-A/-C/-o` 解析），存在 `~/.dsh/presence/hosts.json`。
- **统一通知**：右下角 toast（中文/英文、进/出场动画、7s 错误停留、8s 去重、层级高于设置弹窗）。

### 安装

1. 打开 DSH → 设置 → 插件市场 / 本地安装，选择 `presence-plugin-0.17.1.zip`（zip 内含 `node_modules` 与已构建的 `client.js`，无需联网构建）。
2. 安装后重启 DSH；设置 → Presence 里选择机器、连接、挑一个远端文件夹建工作区。
3. 选中工作区后，终端面板、文件树、agent 工具都会落到那台机器。

### 验证基线（0.17.1）

```
regression 7/7 · API 7/7 · 端口转发端到端 5/5 · 本地端口默认/回退 3/3
通知逻辑 8/8 + 8/8 · 结构检查 16/16 · 工具契约 8/8
bundle 冒烟 PASS · UI 自查 39 类全定义 / 0 硬编码色
```

### 已知限制（诚实写在这里）

- **文件夹不能拖出到资源管理器**：web 平台限制（`DownloadURL` 只能表达单个文件）；等价能力是文件夹行 `↓` → 选本地目录 → 递归落地。
- **ssh config 里的 `ProxyJump` 被忽略**：连接层直连 `HostName`（这是本机一直以来的可用路径）；手动主机 `-J` 只提示不生效。
- **只读代码预览**，不是编辑器；改文件走 `write` / `presence_edit`。
- 端口转发只在 `127.0.0.1` 监听，随连接断开/插件卸载关闭。

## 发布 checklist

- [x] `main` 干净、tag `v0.17.1` 存在
- [x] `package.ps1` 打包成功（构建 `client.js` + 语法检查 + patch 校验）
- [x] zip 校验和记录在本文件
- [ ] 上传到 DSH 插件市场 / 内部分发（需要市场侧账号或上传入口，插件本身不再需要改）
- [ ] 小红书图文发布（见 [`docs/social/README.md`](social/README.md)）
