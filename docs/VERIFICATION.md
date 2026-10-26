# Presence 验收报告

对照最初提出的需求逐条验收。环境：Windows 桌面应用（DeepSeek Harness）+ `server`（Ubuntu 20.04，IPv6，密钥登录），2026-10-23。

## 〇、第二轮：多 agent 体检后的修复（2026-10-24）

多智能体对远程工作区做了约 120 次探针，报出 P0×6 / P1×13 / P2×9。已修复并在真实主机上回归验证：

| 编号 | 问题 | 修复 | 验证 |
| --- | --- | --- | --- |
| P0-2 | 对符号链接 write/edit 会把链接替换成普通文件 | 写入前 `realpath` 解析真实目标，原子替换落在目标上 | 回归脚本 PASS：链接仍是 symlink，目标内容已更新 |
| P0-3 | `presence_read` 只读前 4MiB 且伪报行数 | 上限提到 32MiB；超过则远端 `wc -l` + `sed -n` 窗口读取，行数真实 | `readTextWindow` 对 20 万行文件返回 `totalLines=200000` |
| P0-4 | exec 超时"假取消"，远端进程继续跑 | 用 `timeout --signal=TERM --kill-after=5s` 在远端执行，退出码 124 记为 `timedOut` | 回归脚本 PASS：`timedOut=true` 且远端无残留进程 |
| P0-5 | exec 输出只保留头部 32KiB，全量丢失 | 每流上限 256KiB，超出把**完整输出**落到远端 `/tmp/presence-exec-*.log` 并返回路径 | 回归脚本 PASS：`truncated=true`，落盘文件可读 |
| P0-6 | `present` 卡片打不开远程文件 | 新增 `presence_export`（远程→本地真实文件）+ `processPath` 返回本地挂载路径（GUI 可通过 ctx.fs 预览） | 待用户重启后 GUI 复测 |
| P0-1 | 会话 cwd 与"当前工作区"不一致 | 工具改为按**会话自己的 cwd** 推断主机/根；运行时上下文改为按会话生成；面板删除"设为当前" | 代码完成，待重启复测 |
| P1-6 | 远程会话里 `grep` 报错、`glob` 静默空 | `tools/execute` 拦截：远程会话中的 grep/glob 直接走远端 rg，返回内置工具自己的 value 形状 | 代码完成，待重启复测 |
| P1-9 | 搜索静默失败 | 路径不存在、正则非法（rg exit≥2）都会明确报错 | 代码完成 |
| P1-10 | write 不建父目录 | `presence_write` 自动 `mkdir -p` | 代码完成 |
| P1-11 | `presence_read` 不拦二进制 | 含 NUL 直接拒绝并提示用 exec/terminal | 回归脚本 PASS |
| P1-12 | `presence_edit` 对不存在文件报错含糊 | 先 stat，明确提示"不存在，用 presence_write 创建" | 代码完成 |
| P1-16 | 终端 close 只 detach、TERM 未设置 | `close` 支持 `killSession`；带 session 时先 `export TERM` | 代码完成 |
| P1-17 | 后台命令阻塞 | `presence_exec` 新增 `background:true`（`setsid` + 日志文件，立即返回 pid） | 代码完成 |
| P1-7 | 路径规则不统一 | 所有工具同时接受工作区相对 / 远端绝对 / `presence://` / 本地挂载路径；跨主机路径明确报错 | 代码完成 |
| — | 远程端口访问不到 | 新增 `presence_forward`（复用常驻连接的 `forwardOut`） | 代码完成 |

回归脚本：`node scripts/regression.mjs server` → 5/5 PASS；`node scripts/job-probe.mjs server` → 6/6 PASS。

## 〇之二、第三轮：P0 修复（2026-10-24 晚）

第二轮复测又报出 6 个 P0。逐项处理：

| 问题 | 根因 | 修复 |
| --- | --- | --- |
| present 对本地导出文件报 file not found | `resolveRemoteInput` 把 `C:\...` 当成"远程相对路径"拼到工作区根下 | Windows 盘符/UNC 路径一律按本地处理（`src/mounts.js`） |
| present 的远程文件卡片打不开 | `lstat` 只认 `presence://`，不认**挂载路径**；GUI 预览用挂载路径查询 → 落到空壳目录 | `lstat` 统一走 `resolveRemoteInput`，挂载路径也路由到远端（`src/fs-provider.js`） |
| background 的 pid 是 wrapper、无法停止 | 后台启动逻辑在 tools 层用 `&` 拼 shell | 下沉到连接层：`startBackground/stopBackground/listBackground`（setsid + 进程组 + pgid 信号 + stdbuf 行缓冲），池层提供 `startJob/stopJob/listJobs`，新增 `presence_jobs` 工具 |
| 后台日志恒 0B | C 程序块缓冲 | 启动时自动加 `stdbuf -oL -eL`（探测可用才加） |
| forward 对未监听端口不报错 | 无预检 | 建立前用 `/dev/tcp` 探测，失败立即报 "nothing is listening" |
| ctx.fs write 不建父目录 | 提供方直接写 | 远端写前 `mkdir -p` 父目录 |
| ctx.fs 沙箱边界错误 / `..` 穿越 | fence 用全局"当前工作区" | 改用**每次调用传入的 sandboxPolicy.workspaceRoot**（会话自己的根）做包含判断 |
| grep/glob 只认远端绝对路径 | 拦截器未做路径归一 | 拦截器复用 `resolveRemoteInput`，四种写法全支持；路径不存在明确报错 |
| >32MiB 读 offset 错位/幻影空行 | 自写的 split 解析把标记换行算进正文 | 改用 `connection.readTextWindow` |
| export 可写任意宿主路径、无清理 | 直接 `writeFileSync` | 限制在导出目录内、内容寻址去重、3 天/50 个自动清理、64MiB 上限写进描述 |
| 悬空 symlink 写会沿链接创建 | realpath 失败回退 | 明确拒绝并提示 |
| glob/presence_glob 静默失败 | 未检查根目录与 rg 退出码 | 先 stat 根、rg exit≥2 抛错 |

证据：`node scripts/job-probe.mjs server` → 6/6（后台任务启动/日志/停止/列表、隧道预检、隧道连通 HTTP 200）；路径解析矩阵单测 6/6。`present` 的 GUI 预览依赖 `lstat` 修复，需重启后由用户复测。

**仍存在的边界**：卡片上的"原生打开"按钮对虚拟路径仍不可用（跨进程 `processPathFromHostPath` 无法映射），预览可用；要原生打开需走 `presence_export` 后的真实本地文件。

## 〇之三、第四轮：长程 dogfood（26 条摩擦）修复（2026-10-24 下午）

用 5 个并行 agent 跑真实任务（4.37GB CSV 全量统计 ×3 路独立复算、代码修复、HTTP 服务+转发、资产清点、独立验证）后收集的清单。本轮处理 P0：

| 问题 | 修复 |
| --- | --- |
| 后台任务无 wait，只能 sleep+tail 轮询 | `presence_jobs {action:'wait', jobId, timeoutMs, tailLines}`，返回状态/退出码/日志大小/末尾日志 |
| 后台 job 无归属，list 全机器广播、易误停 | job 记录 `sessionId/label`；`list` 默认只看本会话，`all:true` 看全部；支持 `stop` 按 jobId 或 pgid |
| 秒退仍报 started、pid 是 wrapper、无法判活 | 启动后存活校验；失败返回 `exitedEarly` + 退出码 + 末尾日志；启动器写状态文件（pgid = pid） |
| 后台日志恒 0B | 启动时自动 `stdbuf -oL -eL` |
| exec 大输出日志无上限（出现 240MB 单文件） | 捕获上限 256KiB/流 + 落盘文件上限 32MiB + 24h/20 份轮转清理 + 返回实际落盘字节数 |
| 无就绪信号 | `connection.waitForPort`；`presence_exec {waitForPort}` 后台启动后等待端口监听 |
| 大文件行数错 17 倍（573MB 报 78k 行） | `streamText` 改为 1MB 分块**真流式**读到 EOF（StringDecoder 保 UTF-8 边界），read 工具据此统计正确行数 |
| grep/glob 绝对 pattern 静默空 | 拦截器与 `presence_glob` 拆解绝对 pattern（dirname→root，basename→glob） |
| grep 200 条静默截断、无法计数 | `presence_search` 增加 `countOnly`，返回 `truncated`/总数；超限明确标注 |
| grep 对大型目录挂 30s 超时、路径不适用无提示 | rg 退出码 ≥2 或超时 → 抛可操作错误（收窄 path/include 或改用 presence_exec） |
| grep/glob 与 presence_search 语义不一致 | 统一 smart-case、跳过二进制（`--binary-files=without-match`）、统一输出 |
| exec 管道吞退出码 | 默认 `set -o pipefail`，可 `pipefail:false` 关闭 |
| /tmp 被拒且提示误导 | 错误文案提示改用 `presence_write`/`presence_exec`，不再承诺不可用的 escalation |
| presence_glob 无 size/mtime、排序反了 | 返回 size/mtime，按 mtime 新→旧排序 |

## 〇之四、第五轮：0.5.0 复测的 6 个 P0（2026-10-24 下午）

| 问题 | 根因 | 修复 |
| --- | --- | --- |
| **单文件搜索 100% 假阴性** | rg 对"单个显式文件"默认不输出文件名，`path:line:text` 解析器把每一行都丢掉 | rg/grep 一律加 `--with-filename` / `-H`；解析器对非数字行号不再丢行（`lineNumber: 0` 原样输出）；真机验证单文件/目录/中文名/include 组合 |
| **`read` 大文件全量传输**（795MB → tx +843MB） | `streamText` 逐块把整个文件传完 | 连接层开启 ssh2 `compress: true`（文本压缩收益大）；`streamText` 保持真流式（行数正确） |
| **symlink 沙箱逃逸** | 可写性只用**拼写路径**做前缀判断 | 写入前远端 `realpath -m` 解析真实目标，再判包含；工作区内指向外部的链接**拒绝**，指向内部的照常放行（隔离预检 3/3 断言） |
| **反斜杠相对路径静默错位** | `a\\b` 被当成一个文件名 | 相对远端路径统一把 `\` 归一成 `/`（Windows 盘符绝对路径仍按本地处理） |
| **`present` 假成功** | 只记录路径；原生打开对虚拟路径不可用 | 卡片**预览可用**（依赖上轮 lstat 修复）；原生打开仍不可用，文档与运行时上下文明确要求先 `presence_export` |
| **后台日志无上限** | sidecar 日志无限增长（156 个文件） | 启动前按 24h/50 份轮转清理；exec 落盘 32MiB 上限 + 轮转 |

同轮修掉的 P1：`stop` 真实性（不存在的 pgid/已退出 job 返回 `stopped:false` + `reason`；被信号杀死返回 `exitSignal` 143/137）；`jobs` 注册表自动清理（只清已退出，6h/100 条）；`timeoutMs` 对 background 明确无效并提示；`presence_glob` 先全量排序再截断并报总量；`include` 支持逗号列表（`*.txt,*.dat`）与花括号；权限受限子目录**不再吞掉已有命中**（返回结果 + warning）；`presence://` 无主机名明确报错；`presence_jobs` 列表去掉内部 pipefail 前缀。

UI：工作区列表改为**按机器分组**，机器行显示连接状态（绿=已连接），文件夹挂在其下；删除"设为当前"语义残留的绿点。

**验证**：`regression` 5/5、`job-probe` 6/6、`feature-probe` 10/10、隔离预检（路径矩阵 6/6 + 沙箱 3/3）、单文件/逗号 include/权限容错三项真机手测全过。

## 〇之五、第六轮：实际使用反馈（0.6.0）

| 反馈 | 处理 |
| --- | --- |
| 「为什么没有 `presence_edit`？」 | 工具**一直有且已注册**（运行时工具目录可见）。问题是模型习惯用 `cd && sed -i`：已把描述改为"用这个或内置 `edit`，不要用 `sed -i`/`perl -pi`/`python -c`"，运行时上下文加硬性提示，并在 `presence_exec` 检测到 `sed -i`/`perl -pi`/`ruby -i` 时于结果末尾追加纠正提示 |
| 「浏览文件 UI 再优化一下」 | 重做为现代文件浏览器组件：机器徽标、`›` 分隔的面包屑、当前路径等宽显示、条目计数、目录/文件分区排序、文件大小（自动 KB/MB/GB）、行内图标块、hover 高亮、超过 8 条自动出筛选框、空状态插画位、文件点击在下方内联预览；修掉了原来 `// root` 面包屑显示 bug，返回按钮改为图标按钮 |
| 面包屑根标签重复 | 首段固定显示 `/`，段间用 `›`，不再出现 `//` |

### 交互与动效（按 OpenDesign token 契约）

参考 [OpenDesign design-system-agentic](https://open-design.ai/zh/plugins/design-system-agentic/) 的 token 契约，把它的**动效/状态规范**搬到插件 UI（颜色仍用 DSH 主题 token，保证浅色/深色一致）：

| OpenDesign token | 采用值 | 用途 |
| --- | --- | --- |
| `--motion-fast` | 130ms | hover、颜色变化 |
| `--motion-base` | 220ms | 卡片阴影、入场 |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | 所有过渡 |
| `--focus-ring` | `0 0 0 4px accent@28%` | 键盘焦点环 |
| accent hover/active | `color-mix(in oklab, accent, black 8%/14%)` | 主按钮 hover/按下 |
| radius | 8 / 12 / 20 | 按钮·行 / 列表行 / 卡片 |
| elevation | ring 常驻、hover 抬升 | 卡片与按钮 |

每个交互元素都显式定义了 **hover / active / focus-visible / disabled** 四态：
- 次要按钮：hover 变底色 + 上浮 1px + ring，active 回落并缩到 0.98
- 主按钮：hover 用 accent 混黑 8% + 阴影 + 上浮，active 混黑 14%，focus 是 4px 焦点环
- 列表行：hover 底色 + 图标块反色，active 微缩；键盘 Tab 聚焦有环
- 面包屑 / 返回键 / 筛选框：各自 hover 与 focus 态；筛选框聚焦时边框变 accent 并带 4px 环
- 卡片：常驻 1px ring，hover 抬起阴影，进入有 4px 上浮淡入
- 尊重 `prefers-reduced-motion`（关闭全部过渡与入场动画）

实现方式：注入一份 `.dp-` 前缀样式表（内联样式无法表达 `:hover`/`:focus-visible`），面板根节点挂 `.dp-ui` 作为 token 作用域。已确认插件 UI 在 light DOM（无 shadow root 隔离），全局样式表生效。

**验证**：`regression` 5/5、`job-probe` 6/6、`feature-probe` 14/14；`client.js` 语法检查通过。

**验证**：`regression` 5/5、`job-probe` 6/6、`feature-probe` 14/14；`client.js` 语法检查通过。

**仍存在的边界（已文档化）**：`read-before-write` 守卫只作用于内置 fs 工具（`presence_write` 绕开它，新建后 built-in edit 仍需先 read）；四种路径写法全部接受；**ctx.fs 只能写会话工作区**——工作区外（如 Tent）需 `presence_write`/`presence_exec`，这是 DSH 沙箱策略而非远端权限（实测 `test -w /srv/workspace` 为真，presence_write 可写）；`present` 的原生打开对虚拟路径仍不可用（预览可用）。

## 〇之六、第七轮：真实远程开发会话反馈（0.7.0）

一个 agent 在远程工作区跑了 40+ 次 `presence_exec`、改了 11 个文件后提出的问题清单。按「真正卡流程」的三件事优先修：

| 反馈 | 修复 |
| --- | --- |
| **P0-1 没有本地→远程文件通道**（截图/附件传不上去，只能手写 `scp`） | 新增 `presence_import`：吃本地绝对路径（含 `~/.dsh/attachments` 下的截图），二进制安全、可设 `mode`、返回 sha256；上限 64MiB。`presence_export` 同时补上 sha256 输出，两个方向对称 |
| **P0-2 远程编辑丢可执行位**（`100755` → `100644`） | `writeText` 覆盖前读原文件 mode，chmod 应用到暂存文件后再原子 rename；显式 `{mode}` 优先；新文件默认 644。真凶还包括远端 umask=0002（SFTP 默认 0666 落成 664），现在 open 请求直接带 0644 |
| **P0-3 已读状态不互通**（`presence_read` 读过，内置 `edit` 仍报 "file has not been read"） | 利用公开事件 `fs/observed`（owner = `actor.agent.session`）：`presence_read`/`presence_write`/`presence_edit` 成功后主动记账（target + version），内置 `edit`/`write` 随后可直接用 |
| **P0-4 不能创建二进制文件** | 与 P0-1 同一通道解决（`presence_import` 写 Buffer；传输层 `writeBytes` 同样二进制安全并验证 sha256） |
| P1-5 工具远程能力不一致 | README 增加「工具远程能力一览」，矩阵补 `read_image`/Office 行；运行时上下文说明「read_image/present 需先 export」 |
| P1-6 exec 大输出吃上下文 | 内联输出默认降到 16KiB（`maxOutput` 可调 1–256KiB），全量始终落盘并返回路径 |
| P1-8 两套 API 参数不一致 | `presence_edit` 接受 `old`/`oldString`、`new`/`newString`、`replaceAll`/`replace_all` 别名；文档写明「工作区内优先内置工具，工作区外/大文件用 presence_*」 |

**更正**：`read_image` **本来就能直接读远程图片**（实测 `/tmp/presence-img/red.png`：挂载路径与 `presence://server/...` 都返回 70 字节 1×1 PNG）。它内部走 `ctx.fs.resolve` + `ctx.fs.readBytes`，而 Presence 的 fs provider 实现了 `readBytes`，所以不需要先 `presence_export`。此前文档/上下文里"read_image 仅本地"的说法是错的，已改。

**未做（明确说明）**：后台任务完成主动推送（仍用 `presence_jobs wait`）；`present` 原生打开（客户端按宿主 FS 打开，架构限制）。

**验证**：`regression` 5/5、`job-probe` 6/6、`feature-probe` 14/14、`import-probe` 3/3（二进制 sha256 一致、显式 mode 755、覆盖保留 755、新文件 644）。

## 〇之七、第八轮：CPU-only 任务反馈 + 一次真实误删事故（0.8.0）

### P0 危险命令护栏（真事故：`rm -rf .tmesh/$J`，`$J` 为空，整个 `.tmesh` 被删）

`src/destructive.js` + `presence_exec` 的 `confirm` 门：

1. 识别 `rm -r/-f`、`git clean -fdx`、`find -delete`、`shred`、`truncate -s 0`、`dd of=/dev/...`
2. **dry-run**：在"只报告"的 shell 里重跑（`rm` 被 shell 函数遮蔽、`find -delete`→`-print`、`git clean` 加 `-n`），拿到展开后的目标
3. 未定义变量（`set -u`）→ 直接拒绝
4. 无条件拒绝：工作区根、工作区根的祖先、家目录、`/`、`.git`
5. 其余返回目标报告（类型/文件数/体积），**必须 `confirm:true` 才执行**

同轮新增 `presence_trash`：工作区内可恢复删除（远端 `mv` 到 `~/.dsh/presence-trash/<UTC 时间戳>-<随机>/`，返回恢复路径；`restore` 放回）。零安装：只用远端 `mv`/`realpath`/`du`/`find`。

设计要点：
- `~` 在**远端**展开（`$HOME`），不碰本地家目录；拒绝 `/`、远端家目录、家目录祖先、`.`/`..`、不存在的路径、以及"回收站位于被删目录内部"的递归情况
- **符号链接移动的是链接本身**，目标不动（只解析父目录）
- 跨设备时 `strategy:'copy'`（GNU `mv` 内部复制；显式 EXDEV 失败则 `cp -a` + `rm -rf`，失败时保留容器可人工恢复）
- `restore` 缺 `to` 会明确报错；默认不覆盖已存在的目标
- `listTrash` 按容器 mtime 排序（同秒多次也正确），NUL 分隔输出，文件名含换行/引号/中文都能往返

**验证**：
- `node scripts/safety-probe.mjs` → **24/24**：事故原型（空变量报告显示收敛到 `.tmesh` 且不执行）、根/祖先/家目录/`.git` 拒绝、`git clean` dry-run 只列不删、确认后仍先检查、trash 往返（内容与 750/640 权限一致）、拒绝 `/`
- 独立验收（连接层 45/45）：符号链接、含换行/引号/中文的路径、跨设备 `/dev/shm`、同秒排序、`~user` 根拒绝、EXDEV 回退、非 EXDEV 失败时源不变

### P1 已读状态压缩后丢失

根因：harness 的守卫状态是 `WeakMap<Session, ...>`，会话被重建/压缩后丢失。修法：新增 `src/observed-store.js`，按 `(sessionId, presence://host/path) -> version` 持久化到 `~/.dsh/presence/observed.json`；
- 内置 `read`/`read_image` 成功后记账（`tools/post-execute`）
- `presence_read`/`write`/`edit` 也写入同一存储
- 内置 `edit`/`write` 执行前（`tools/pre-execute`），若记录版本 == 当前版本，则重新发布 `fs/observed`，守卫通过；文件已变则不发布（守卫照常拦住）

`read limit=1` 这类局部读取也算已读（记录的是读取时刻的版本）。

### P1 远程写入丢可执行位（上一轮已修）

0.7.0 起 `writeText` 覆盖前读原 mode、chmod 暂存文件后原子 rename；新文件 644（修正了远端 umask=0002 导致的 664）。本轮复核仍在，`safety`/`regression` 回归通过。

### P2 exec 长输出

内联输出默认 **16KiB**，改为**首尾截断**（保留开头命令输出 + 结尾错误），全量落盘并返回路径；默认**剥离 ANSI/控制字符**（`raw:true` 可保留），解决 htop/控制序列污染上下文。

### P3 能力变化提示

运行时上下文首行改为 `Presence <version>: ...`，并写入本轮新增能力（trash、危险命令 dry-run、guard 自修复）——升级后模型立刻能看到版本与新增能力。

## 〇之八、第九轮：面板终端直连远程（0.9.0）

问题：DSH 右侧终端面板由 `terminal-controller` 创建，它固定用**本地** `subprocess` 起 shell（`spawn` 里 `subprocess.spawnTerminal({argv:[shell.path,...], cwd})`），cwd 又是挂载路径（空壳目录）——所以打开的是本机 `cmd.exe`，与远程无关。`terminals` 服务的 `registerBackend` 只服务模型侧终端工具，面板不走它。

方案（不改 DSH）：把 `terminal-controller` 的默认 shell 换成一个 launcher。

- `scripts/presence-shell.ps1`：cwd 在 `~/.ssh` 挂载根下时解析出 `<host>` 与远端路径，执行 `ssh -t <host> "cd '<远端目录>' && exec $SHELL -l"`；否则起本地 `cmd.exe`（本地工作区行为不变）
- 以 **`-EncodedCommand`（UTF-16LE base64）** 内嵌进 `cordis.patch.yml` / `presets/*.patch.yml`，因此**不需要绝对路径、不需要安装器步骤、可移植**；源码仍是 `.ps1`，用 `node scripts/embed-shell.mjs` 重新生成，`--check` 防 stale（打包脚本会校验）
- 补丁写法：`- id: terminal-controller` + `config.shell`（按 Loader 方言，config 整体替换，其余字段走 schema 默认值）

验证：
- launcher dry-run（`PRESENCE_SHELL_DRY=1`）四类 cwd 全对：远端子目录 → `HOST=server / REMOTE=/srv/app`；host 根 → `/`；含空格与中文的嵌套路径 → 原样保留；本地 cwd → `LOCAL`
- 远端命令引号实测：`cd '/srv/app' && exec "${SHELL:-/bin/bash}" -lc 'pwd; echo QUOTING_OK'` → 输出 `/srv/app` / `QUOTING_OK`
- 补丁文件用 harness 自带 `js-yaml` 解析通过，`terminal-controller` patch 的 base64 可解码回 launcher 源码
- 回归：`regression` 7/7、`safety-probe` 24/24

**验证**：`safety-probe` 21/21、`regression` 5/5、`job-probe` 6/6、`feature-probe` 14/14、`import-probe` 3/3。

## 〇之九、第十轮：侧边栏文件浏览器（XFTP 风格）0.10.0

右侧栏「开始」页新增 **远程文件** 标签页（注册 `sidebarRightTabs`，kind `presence-files`），打开时自动跟随当前会话的工作区（没有就用第一个工作区）。

host 端新增 6 个 API（`src/api.js`，双前缀注册）：

| 端点 | 作用 |
| --- | --- |
| `GET /entries?host=&path=` | 目录列表：name/kind/size/mtime/mode/hidden + crumbs，目录优先排序 |
| `GET /raw?host=&path=&download=1` | 二进制直出：按扩展猜 content-type、支持 Range、SVG 加 CSP sandbox、64 MiB 上限 |
| `POST /upload?host=&dir=&name=&mode=` | 原始 body 写入远端（二进制安全、mkdir -p、返回 sha256 与 mode） |
| `POST /mkdir?host=&path=` | 新建目录（含父级） |
| `POST /remove?host=&path=` | 走 `connection.trash`，返回回收站路径（可恢复） |
| `GET /context?sessionId=` | 会话 cwd → 工作区 `{host, path, title}`，非挂载返回 null，服务缺失返回 503 |

客户端能力：
- 拖拽本机文件到列表（或 `＋`）→ 逐个上传并显示百分比进度
- 双击图片 → 弹窗预览；双击文本/代码 → 预览前 256 KiB；其余 → 「另存为」对话框（File System Access API，不可用时回退浏览器下载）
- 行尾 `↓` 保存到本地、`🗑` 移入远端回收站、`▣` 新建文件夹、`⟳` 刷新、筛选框、面包屑、机器下拉
- 设置面板首次加载/切换目录显示旋转加载动画（此前空白无提示）

边界（下一轮已细化）：文件可以拖出到资源管理器，目录不能——具体原因与替代方案见 〇之十。反方向（资源管理器 → 页面）是标准 HTML5 拖放。

**验证**：直接调用 route handler（真实 ssh 连接）7/7 —— entries 有目录+文件且带 mtime、upload 二进制 sha256 与字节数一致、raw 返回完全相同的字节且 disposition=attachment、mkdir 嵌套成功、remove 进回收站且目录里消失、context 在无 DSH 服务时 503、`/api/presence/*` 双前缀存在。

## 〇之十、第十一轮：文件浏览器体验修复（0.11.0）

真实使用后反馈的四条：

| 反馈 | 修复 |
| --- | --- |
| 代码没有高亮、字体不对 | 预览改为行号 + 轻量语法高亮（注释/字符串/数字/关键字/函数调用五类着色，零依赖的分词器，React 节点输出无注入面）；等宽字体栈 `JetBrains Mono → Cascadia → Fira Code → ui-monospace`；深色模式单独配色 |
| 鼠标放上去没有动效 | 行 hover/active/focus-visible、图标块反色、操作按钮 hover 才亮（`.dp-pane-actions` 透明度过渡）、工具栏按钮态、进度条与 indeterminate 动画，全部用 OpenDesign 的 130ms / `cubic-bezier(.2,0,0,1)` |
| 文件夹拖不动 / 不要 tar.gz | 改为真目录语义：**上传**支持拖入文件夹（`webkitGetAsEntry` 递归）+ 目录选择 input，按原结构递归 `mkdir`+上传；**下载**点 `↓` 选本地目标文件夹后递归落地成真实目录树（进度显示文件数与字节数）。不再产生任何 tar.gz |
| 拖文件进来被聊天框也捕获 | 面板在 `window` **捕获阶段**监听 `dragenter/dragover/dragleave/drop`，命中面板才 `preventDefault + stopPropagation`，聊天框不再同时收到附件；底部常驻进度条（百分比/文件名/完成态） |
| （顺带）设置页加载空白 | 已在上轮修好，本轮保留 |

**拖出的准确边界**：文件能拖出（Chromium `DownloadURL` 把 URL 下载成临时文件交给系统）；**目录不能拖出**是 web 平台限制——`DownloadURL` 只能表达一个文件，目录拖出必须由 Electron 主进程 `webContents.startDrag({files:[目录]})` 发起，而 DSH host 是独立 Node 子进程（`app.asar/lib/main.js:3794` `spawn(node)`），主进程与 host 之间仅有 `/api/*` 转发，没有拖拽通道。需要在 DSH 上游加一条 IPC，插件层无法实现；等价能力是 `↓` 递归下载。

**验证**：嵌套目录树端到端 3/3（递归建目录 + 4 个文件含中文/空格名上传、递归遍历全部找回、嵌套文件 `/raw` 字节一致、整棵树进回收站）；API 端点 7/7；`client.js` 语法检查通过。

## 〇之十一、第十二轮：密码机、取消、目录 UI（0.12.0）

| 反馈 | 修复 |
| --- | --- |
| 需要密码的服务器直接报 `authentication failed: no usable key, and no password was supplied` | 文件面板识别认证类错误（`isAuthMessage`），弹出**密码对话框**（密码 + 「记住这台」+ 取消），提交走 `POST /connect` 后自动重载当前目录；取消后不残留错误态。密码默认仅内存，勾选记住才交给凭据服务 |
| 下载文件夹点取消却报错 | `showDirectoryPicker` 的 `AbortError` / `SecurityError` 视为取消，静默返回（不弹错误） |
| 目录 UI 不够好 | 按 **OpenDesign (Lens)** 规范重做：4px 网格间距（8/12/16）、圆角 4/8/12/pill、`1px ring + 0 10px 24px rgba(0,0,0,.08) + 0 1px 2px` 的柔投影（不用重投影）、动效 `100ms micro / 170ms small / 300ms medium` + `cubic-bezier(.4,0,.2,1)`、聚焦环 4px accent@28%；胶囊型工具栏按钮与面包屑、单色表面 + 单一点缀色、行 hover 才显操作、芯片式类型标签、弹窗 12px 圆角 + 淡入上浮、空状态图标块 + 文案；代码预览配色降饱和以符合"少点缀色" |

设计 token 对照（OpenDesign Lens → 实现）：
| OpenDesign | 实现 |
| --- | --- |
| spacing 4/8/16/24 | `8px` 工具区、`4px` 行内边距、`16px` 弹窗内边距 |
| radius sm 4 / md 8 / lg 12 / pill | 行 8、弹窗 12、按钮与面包屑 pill、图标块 8 |
| shadow `0 0 0 1px + 0 10px 24px 8% + 0 1px 2px 5%` | `.dp-elevated` 原样采用 |
| motion 100/170/300 + cubic-bezier(.4,0,.2,1) | `--dp-micro/small/medium`、`--dp-ease` |
| focus ring 4px accent 28% | `--dp-ring` |
| 禁止：重投影 / 多点缀色 / 装饰插图 | 只用 1px ring + 柔阴影，唯一强调色是 brand（进度、聚焦） |

**验证**：`client.js` 语法检查通过；服务端端点未改动（沿用 7/7 结果）；打包 `--check` 通过。

## 〇之十二、第十三轮：hover 失效根因 + 目录面板整体重构（0.13.0）

**根因（这次找到了）**：浅色主题下 `--dsw-alias-bg-layer-1` 与 `--dsw-alias-bg-layer-2` **是同一个颜色**（都是 `--dsw-static-neutral-bluish-00`，即纯白）。之前所有 hover/选中态都用 `bg-layer-2` 做背景，于是"hover 变色"实际是白→白，肉眼完全看不出来；点击时看到的"框"其实是 `border-l2`。这解释了为什么每一轮调样式都没真正解决。

**修复方式**：全部改用 harness 主题**专为交互定义**的 token：

| 用途 | token | 浅色 / 深色 |
| --- | --- | --- |
| hover 背景 | `--dsw-alias-interactive-bg-hover` | `#2631480f` / `#ffffff14`（始终可见） |
| 选中行背景 | `--dsw-alias-bg-multi-select` | `neutral-bluish-60` / `neutral-850` |
| 填充块（图标块/输入框/当前面包屑） | `--dsw-alias-bg-module-platform` | `bluish-60` / `bluish-800` |
| 分隔线 / 描边 | `--dsw-alias-border-l2` / `-l3` | `#0000001a` / `#0000001f` |
| 强调（进度、聚焦、文件夹图标） | `--dsw-alias-state-business-primary` | deepseek-500 / 400 |
| 动效 | `--ds-transition-duration-fast` (` .1s`) / `--ds-transition-duration-slow` (` .3s`) + `--ds-ease-in-out` (`cubic-bezier(.4,0,.2,1)`) | 与 OpenDesign 完全一致 |
| 圆角 | `--dsw-radius-xs/sm/md`（4/8/12） | 主题原生 |

**整体重构内容**：
- **真图标**：内置 16 个描边 SVG 图标（Lucide 几何）——folder / file / code / text / image / download / trash / plus / folder-plus / refresh / upload / chevron / x / lock / check / alert / server / search；工具栏、行首、行尾操作、面包屑分隔、空状态、密码框、弹窗头部全部换成图标，不再用 emoji
- **行状态**：默认 / hover（可见底色）/ 选中（multi-select 填充）/ 按下 / `:focus-visible`（2px business-primary 外框）；行尾操作默认隐藏、hover 或键盘聚焦才出现
- **禁止文本误选**：面板、行、工具栏、面包屑全部 `user-select: none`（代码区、输入框、路径文本保留可选中），双击不再出现蓝色文字选中
- **列布局**：新增「名称 / 大小 / 修改时间」列头；大小、时间右对齐、等宽数字；行高 34px
- **弹窗**：ESC 关闭、头部图标 + 类型 chip、路径等宽显示、底部主按钮带下载图标；遮罩淡入 + 弹窗上浮 300ms
- **密码框**：锁图标 + 标题、按钮改成面板同款胶囊按钮
- **进度条**：图标 + 标签 + 线性进度 + 详情行，完成态换成勾选图标
- **空状态**：圆角图标块 + 文案（区分"空目录"与"无匹配"）
- 设置面板的按钮/输入框/行的 hover 也同步从 `bg-layer-2` 换成 `interactive-bg-hover`（同一根因，原来在设置页也不明显）

**验证**：`client.js` 语法检查通过；CSS 括号平衡检查通过；服务端未改动（沿用 API 7/7、regression 7/7、safety 24/24）；打包 `--check` 通过。

## 〇之十三、第十四轮：预览改用 CodeMirror 6 + 媒体预览 + 客户端构建管线（0.14.0）

问题：代码预览是手写的正则高亮 + 手写行号；字体没保证（这个环境里 fallback 到了比例字体），也没有编辑器的观感（无折叠、无选区、无滚动边栏）。媒体只能预览图片。

做法：**复用成熟组件，不再手搓**。

- **CodeMirror 6**（`codemirror` + `@codemirror/language-data`）：只读 `EditorView`，行号、代码折叠、按文件扩展名自动识别语言（`LanguageDescription.matchFilename`，覆盖 40+ 语言）、`HighlightStyle` 自定义配色、跟随主题明暗（读取 `--dsw-alias-bg-layer-1` 亮度判断）、`EditorState.readOnly` + `EditorView.editable.of(false)`
- **字体**：显式 `"Cascadia Code", "JetBrains Mono", "Fira Code", Consolas, "Courier New", "Microsoft YaHei", ui-monospace, monospace` —— Windows 一定有 Consolas，不再依赖 `--ds-font-family-code` 的解析结果
- **媒体**：图片（`<img>`）、视频（`<video controls>`）、音频（`<audio controls>`）、PDF（`<iframe>`，`/raw` 已支持 Range 所以能拖动进度）；都不支持的才走另存为
- **构建管线**：`client.js` 由 `client-src/{entry,app,editor}.js` 经 Rollup 打包（IIFE、terser 压缩、CodeMirror 内联 `inlineDynamicImports`）。构建依赖装在 `.dev/`（gitignored），运行时 zip 仍只依赖 `ssh2`
- `package.ps1` 现在**先构建再检查**：`.dev` 缺失直接报错并给出安装命令；构建产物 `client.js` 1.58 MB（压缩前 2.9 MB）

验证：
- `node scripts/build-client.mjs` → `client.js 1614 KiB (minified: true)`
- `node --check client.js` 通过
- 无浏览器冒烟测试（vm + 假 `window.__ModuleLoader__` / React stub）：bundle 注册 `id=dsh-presence`，factory 返回 `{ inject, apply }` —— **PASS**
- 服务端未改动：API 7/7、regression 7/7

**仍未做**：真正的编辑（现在是只读预览）、语法高亮主题与宿主主题的 token 级联动（当前按亮度二选一调色板）。



**验证**（全部在真实主机 server 上）：
- `node scripts/regression.mjs server` → 5/5
- `node scripts/job-probe.mjs server` → 6/6
- `node scripts/feature-probe.mjs server` → 10/10（waitJob 退出码+日志尾、秒退识别、会话过滤、pgid 停止、端口就绪、绝对 glob、统计与截断、缺失路径报错）
- 兼容性：server 的 rg 11.0.2 不接受 `--binary-files`，代码检测到即回退并缓存；`head` 截断产生的 SIGPIPE 141 不会误判为失败。

## 〇之十四、第十五轮：预览细节修正（0.14.1）

| 反馈 | 修复 |
| --- | --- |
| `package-lock.json` 没有高亮、也没有行号 | 根因：`.json/.yaml/.toml/.xml/md…` 只在高亮列表 `TEXT_EXTENSIONS` 里，而预览分支只把 `CODE_EXTENSIONS` 送进 CodeMirror，于是落到了纯 `<pre>` 路径。现在两类合并为同一集合，**所有文本类文件都进 CodeMirror**（语言识别成功就着色，识别不出也至少有行号/选区/等宽/折叠） |
| 预览细节 | 增加「复制全部内容」按钮（复制图标 + 1.5s「已复制」反馈）；文本读取上限 256 KiB → **1 MiB**（服务端 `/file` 同时返回 `cap`，客户端按实际值提示）；超限时弹窗顶部显示 banner「只预览了前 X（完整 Y）」，页脚标记「已截断」 |
| 兜底与观感 | CodeMirror 挂载失败时回退为等宽 `<pre>`，不再出现空白面板；编辑器容器加圆角、gutter 右侧分隔线、细滚动条 |

**验证**：`build-client` 重新打包（1615 KiB minified）→ `node --check client.js` → bundle 冒烟测试 PASS（注册 `id=dsh-presence`、返回 `{ inject, apply }`）；产物里确认包含 `jsonLanguage` / `yamlLanguage`（JSON/YAML 高亮可用）；API 端点 7/7。

## 〇之十五、第十六轮：手动主机 + 已连接状态 + 图标（0.15.0）

需求：`~/.ssh/config` 里没有的机器也要能连，例如
`ssh -CAXY user@server`；插件自己记住，不写 ssh config。顺带：已连接工作区的状态要维护（绿点），并换一个好看的图标。

**手动主机**（`src/custom-hosts.js` + `/api/presence/custom-hosts`）：
- 解析一条 ssh 命令：`ssh` 前缀、`-p/-l/-i/-F/-o/-J`、组合短开关（`-CAXY`）、`user@host[:port]`、`ssh://user@host:port`、`[IPv6]:port`；引号与反斜杠转义；`ProxyJump` 识别但仅警告（连接层不支持跳板，会直连目标）
- 存储：`~/.dsh/presence/hosts.json`（mode 0600，最多 100 条），**绝不写 `~/.ssh/config`**
- 合并：`readSshConfig()` / `listHosts()` 把手动主机并进同一视图，因此 `/state`、工作区、文件浏览器、终端、`presence://` 挂载路径全部自动可用；别名冲突（含 config 已有别名）直接拒绝
- 界面：选机器界面「手动添加主机」→ 粘贴命令 / 别名 / 备注 → 列表出现带「手动」徽章的行，可删除（删除同时断开连接）

**已连接状态维护**：面板每 5 秒 + 窗口重新聚焦时刷新 `/state`；绿点加 3px 光晕、行内显示「已连接」；工作区分组头部同样刷新，不再出现连上却显示灰点。

**图标**：换成圆角渐变底板 + 终端窗口（`>_`）+ 绿色在线脉冲的 SVG（`icon.svg`）。

**验证**：
- 解析器 + 存储 12/12（含 example 命令、-p/-i、IPv6、ssh URI、ProxyJump 警告、重复别名拒绝、合并视图、删除）
- 端到端 6/6：API 添加 → `/state` 显示 `source=manual` → **真实 SSH 连接**成功（`user@server`）→ `connected=true` → 删除后列表为空
- **回归发现**：`server` 的 ssh config 里带有 `ProxyJump`，而连接层一直是直连并且可用；新加的"拒绝 ProxyJump"守卫会让这个主机全部失败（api-check 5 项 FAIL、进程崩）。守卫已移除，注释说明 ProxyJump 被有意忽略（手动主机按 `-J` 只给警告）
- 全量：API 7/7、regression 7/7、client bundle 构建 + 冒烟 PASS

## 〇之十六、第十七轮：端口转发面板（0.16.0）

需求：远程经常要把端口转发到本地看网页服务，需要维护"哪些端口在转发"，并放在容易看到的位置。

底层 `pool.openTunnel/listTunnels/closeTunnel` 和 `presence_forward` 工具早就有；这一轮把它变成**可见、可操作**的：

- **HTTP API**（`src/api.js`）：`GET /presence/api/tunnels`（实时列表）、`POST`（`{host, remoteHost?, remotePort, localPort?}` → 打开并返回 `url`）、`DELETE ?id=`（关闭）。与工具共用同一个 tunnel 注册表
- **右侧栏第二个标签「端口转发」**（`TunnelPanel`）：
  - 顶部一行表单：机器下拉 + 远程主机（默认 `127.0.0.1`）+ 远程端口 →「开始转发」
  - 按机器分组的实时列表：`远程主机:端口 → 127.0.0.1:本地端口`，每行「打开」（`target=_blank` 直连）/「复制」/ 停止
  - 每 4 秒轮询：agent 用 `presence_forward` 开的、别处关掉的都会同步
  - 空状态给出用法提示；错误走统一 banner
- **设置 → Presence**：工作区列表下方新增「端口转发」只读区块（数量 + 地址 + 打开/停止），不看右侧栏也能知道
- 样式复用文件面板的 `.dp-pane/.dp-toolbar/.dp-entry` 体系（主题 token、图标按钮、hover 态）

**验证**：真实主机端到端 5/5——
1. `POST /tunnels` 打开转发（返回 `http://127.0.0.1:7357`）
2. `GET /tunnels` 列出该转发
3. 通过该本地端口 `fetch` 远程 `python3 -m http.server`，**HTTP 200，844366 字节**（真的拿到了目录列表）
4. `DELETE /tunnels` 关闭，`closed=true`
5. 关闭后列表为空

（期间修复：`POST` 返回的 tunnel 少了 `url` 字段，测试立刻抓到，已补上。）

另：API 7/7、regression 7/7、client bundle 1625 KiB 构建 + 冒烟 PASS。

## 〇之十七、第十八轮：端口面板按规范重做 + 自查（0.16.1）

反馈：端口面板"又没按之前那种规范和标准"。**重新对照文件面板的体系逐项检查**，确认的问题与修复：

| 检查项 | 发现 | 修复 |
| --- | --- | --- |
| 颜色/背景 | 行内用 `background: var(--dsw-alias-bg-layer-1)`、自定义 border 拼"卡片"，没走统一 surface | 全部改成主题 token 类（`.dp-entry`、`.dp-iconbtn`），面板内**硬编码颜色 0、行内颜色 0** |
| 输入控件 | 自定义 `field` 常量（height/padding/border 手写） | 用 `.dp-select` / `.dp-input`（标题栏同款 28px 高度、圆角、focus ring） |
| 行结构 | 每行一个 inline 盒子，无 hover/无图标体系 | 复用 `.dp-entry`：行 hover 底色、图标 tile、两层信息（route 行 + URL 行） |
| 操作按钮 | 文字按钮「打开/复制/停止」混排 | 统一 24px 图标按钮（↗ 打开 / 复制→✓ / 电源停止 hover 变红），带 title |
| 分组头 | 内联字号/颜色 | `.dp-group` + `.dp-group-head`：连接状态点（`.dp-dot--on` 带光晕）+ 主机名 + 数量 chip + 未连接提示 |
| 空状态 | 一行文字 | `.dp-empty` 图标块 + 标题 + 用法提示（`.dp-empty-hint`） |
| 加载/禁用 | 首屏空白、按钮可重复点 | 首屏 Spinner；刷新图标旋转（`.dp-spinning`）；`busy` 期间按钮禁用 + 重入保护 |
| 窄侧边栏 | 表单 5 个控件挤一行会溢出 | 两行自适应：机器下拉独占一行，其余控件第二行；URL 可收缩省略（`min-width:0`） |
| 错误提示 | 直接抛 ssh 原文 | 统一 `.dp-banner`（图标 + 文本）；认证失败时提示"先去「远程文件」面板连接一次" |
| 设置页同名区块 | 纯 inline 拼的列表 | 改成 `.dp-card` 卡片：图标 + 标题 + 数量 chip + `.dp-row` 行 + `.dp-link` + 停止按钮 |

**自查脚本**（`.scratch/ui-audit.mjs`，每轮跑）：
- 收集面板里所有 `className`，对照样式表 → **36 个类全部有定义**
- 扫描硬编码颜色与行内 color/background → **0**
- 行内样式只剩结构性两项（容器 `height:100%`、spacer `flex:1`），与文件面板一致

**验证**：`build-client` → 1629 KiB（minified）→ `node --check` → 冒烟 PASS；端口转发端到端 5/5（真实远程 `http.server` 经隧道取回 844366 字节）；API 7/7；regression 7/7。

## 〇之十八、第十九轮：统一通知 + 端口表单可读性（0.17.0）

反馈：① 端口面板"看不懂"、报错没整理；② 插件里所有报错/提示风格不统一，红色内联块、英文、秒消失、没动画。③ 希望 agent 调工具开转发，面板自动显示。

### 端口表单可读性
| 问题 | 修复 |
| --- | --- |
| 两个输入框只有 placeholder，没有可见标签，用户把 `127.0.0.1:8000` 填进"远程主机" → 报错 `127.0.0.1:8000:8000` | 每个字段加**可见标签**（机器 / 远程主机 / 远程端口）+ 底部说明"将 server 上的 127.0.0.1:8000 映射到本地随机端口…"；客户端与服务端**双向自动拆分** `host:port`（含 `[IPv6]:port`）；单测 4/4 |
| 报错原文生硬 | 结构化错误：标题（中文）+ 建议 + 原始细节；端口无监听时显示"远程 127.0.0.1:8000 上没有服务在监听 / 先在 server 启动服务"（服务端拆分后不再重复端口；API 测试 2/2） |

### 统一通知系统
- **单例 toast 栈**：`react-dom/client` 的 `createRoot` 挂到 `document.body`（设置面板 + 两个侧边栏面板共用），最多 5 条
- **样式**：右下角卡片，severity 色条（error/warning/info/success）+ 图标 + 标题 + 建议 + 等宽原始细节 + 关闭 × + 底部剩余时间进度条；全部主题 token，无硬编码颜色
- **动画**：进场 220ms 上浮淡入、退场 170ms 下沉淡出；`prefers-reduced-motion` 下 1ms
- **时长**：success 2.6s / info 3.6s / warning 5.2s / error 7s；`error` 不再被轮询清掉（内联 error state 已移除）
- **去重**：同 kind+标题 8 秒内只弹一次（轮询失败不会刷屏）
- **i18n**：`LOCALE` 按页面语言选中文/英文目录；后端英文报错模式识别 → 中文标题 + 建议（认证/端口无监听/连接拒绝/DNS/超时/未知主机/权限/文件不存在），已是中文的消息原样保留
- **接入**：45 处 `setError(...)` 全部改为 `notifyError(...)`；密码对话框内部错误也走 humanize；新增成功提示（添加/删除主机、转发建立/停止、复制、上传完成）
- **agent 工具**：`presence_forward` 描述与返回值明确写出"右侧栏端口转发面板会自动同步"，open 返回 local URL + 停止命令；面板 4s 轮询同一注册表 → agent 开的转发自动出现（工具契约静态断言 4/4）

### 验证
- 本地化 + 通知逻辑（无浏览器，vm 加载 bundle 调 `__test`）：**16/16**（5 类错误映射、插值、中文透传、null 容错、送达、时长、去重、空值）
- `splitHostPort` + 工具契约：**8/8**
- API 7/7、regression 7/7、端口转发端到端 5/5、拆分与重复端口 2/2、bundle 冒烟 PASS、UI 自查 39 类全定义 / 0 硬编码色 / 0 行内颜色
- `build-client` → 1643 KiB（minified）；打包 `--check` 通过

## 〇之十九、第二十轮：通知层级/语言 + 本地端口默认同号（0.17.1）

### 1. toast 被设置弹窗的遮罩压暗
截图里右下角通知在设置弹窗打开时是灰的——`z-index: 90` 低于设置遮罩。改为 **`z-index: 2147483000`**（固定定位、`pointer-events` 正确），任何弹窗之上都清晰可见。

### 2. toast 仍是英文
根因：`LOCALE` 是**模块加载时就固定的常量**，而 harness 的 locale 插件在插件加载**之后**才把 `<html lang>` 设成 `zh-CN`，于是常量冻结在 `en`。改为 `currentLocale()` **每次调用时读取** `<html lang>`（缺失再退回 `navigator.language`，默认 zh）；`t()`、关闭按钮文案、`humanizeError` 全部走它。结构断言验证：不再有 `const LOCALE = (`，`t()` 使用 `currentLocale()`。

### 3. 本地端口应当默认与远程相同
| 行为 | 实现 |
| --- | --- |
| 不填本地端口 | `pool.openForward` 让本地端口 = 远程端口（8000 → 8000） |
| 该本地端口被占用 | 自动回退到系统分配端口，返回 `localPortFallback / requestedLocalPort`，界面弹警告说明并提示可手动指定 |
| 想自己指定 | 表单新增「本地端口」字段（留空 = 同号），API/工具都支持 `localPort` |
| agent 工具 | `presence_forward` 走同一个 `openForward`，结果里注明"同号/回退"，面板照旧自动出现 |

**验证（真实主机）**：
- 本地端口默认同号：`remote=19300 local=19300 fallback=false` ✅
- 占住本地 19300 再转发：`requested=19300 actual=9397 fallback=true` ✅
- 显式 `localPort=19500`：`local=19500` ✅ → **3/3**
- 结构检查 16/16（locale 惰性读取、z-index、动画、进度条、reduced-motion、本地端口字段、openForward/EADDRINUSE、API/工具都走 openForward）
- 通知逻辑 8/8 + 8/8、工具契约 8/8、API 7/7、regression 7/7、端口转发 5/5、拆分 2/2、bundle 冒烟、UI 自查全通过
- `build-client` → 1643 KiB（minified）；打包 `--check` 通过






## 〇之二十、第二十一轮：转发崩溃修复 + 手动主机表单（0.17.3）

崩溃根因（来自 crash 日志 + ssh2 源码）：端口转发的本地 `net.Server` 回调调用 `ssh2 forwardOut` 时连接已断，
ssh2 1.17 **同步抛 `Not connected`**，异常从 EventEmitter 回调冒泡成 host 进程的 `uncaughtException` → DSH host exit 1。
悬空转发的来源：`disconnect(host)` 与 idle reaper 都不关闭该 host 的隧道（reaper 还会主动断连），于是"SSH 已断、端口仍在监听"。

修复（src/core/connection.mjs + src/pool.js）：
- `tunnel()` 的 `forwardOut` 包 try/catch；断线只 destroy 本地 socket；
- 每连接记录隧道集合，SSH `close` 时全部关闭；隧道 `close()` 幂等；
- `pool.disconnect(host)` 关闭该 host 所有隧道；`#reapIdle` 跳过有活跃隧道的 host，并把已断连 host 的隧道一并清掉。

**验证**：新增 `scripts/tunnel-crash-probe.mjs` → **5/5**：
1) tunnel 本地监听就绪；2) 假 client 同步 throw 时 0 uncaught（旧代码会崩）；3) 触发 SSH close 后本地端口 refused（隧道已关）；
4) pool 记录转发；5) `disconnect(host)` 关闭该 host 的转发且列表清空。
另：手动添加主机表单改紧凑（单行 42px 命令框 + 别名/备注并排 + 标签），client 重建后冒烟通过。

## 〇之二十一、第二十二轮：agent 工具 UX 补齐（0.17.4）

来源：一个 OpenCode agent 在长任务里通过 Presence MCP 使用同一套内核，报告了 8 类工具摩擦；本轮把这些行为移植回 DSH 插件的 `src/tools.js`（内核未改，未指定的默认行为保持不变）。

- `presence_read`：新增 `raw:true`（逐字节原样，无路径头/行号/footer）与 `numbered:false`（去行号与 footer、保留路径头）；默认仍是行号 + `(End of file - N lines)`。
- 新增 `presence_read_many`：一次读 1-50 个文件，按 `=== <path> ===` 分段，`raw`/`limit` 可选；单个文件读不了只在该段报 `error: ...`，不会失败整次调用；总输出按 32 KiB 截断。
- `presence_exec`：`format:"json"` 返回 `{cwd, command, exitCode, signal, durationMs, timedOut, stdout, stderr, stdoutTruncated, stderrTruncated}`，stdout/stderr 各截 16 KiB 且保持合法 JSON；`saveStdout` 在 exit 0 的前台命令后原子写 stdout（自动建父目录，报告 path/bytes），非 0 或后台任务带 note 跳过。
- `presence_write`：写后 `stat` 回读并报告真实字节数、八进制 mode（`0644`，未显式设置时不再出现 `0`）和 sha256 前 16 位；`format:"json"` => `{path, sizeBytes, mode, sha256}`。
- `presence_edit`：返回上下文 ±2 行、最多 100 行/8 KiB 的紧凑 diff；`dryRun:true` 只校验锚点、不写文件；`format:"json"` => `{path, replaced, dryRun, bytesBefore, bytesAfter, diff}`；歧义拒绝与 replaceAll 语义不变。
- `presence_jobs`：新增 `status`（id/host/state/exitCode/exitSignal/pid/label/startedAt/logPath/logSize/command/cwd）；`stop` 后用远端 `ps -p <pid> -o pid=` 复核并给出 `alive`/`verified` 和退出摘要；list/status/stop 支持 `format:"json"`。
- `presence_forward`：open/list/close 支持 `format:"json"`（open 含 `requestedLocalPort`/`localPortFallback`）。
- `presence_trash`：trash 后回查源已消失（`sourceRemoved`）并给 `restoreHint`/`sizeBytes`；list 把 ISO 时间归一化为毫秒、最新在前、支持 `path` 子串过滤和 `format:"json"`；restore 支持 `format:"json"`。

**验证**（server，2026-10-25）：
- `node --check src/tools.js` 通过。
- 临时工具级探针（stub `defineTool`，直接调用每个 `execute()`）：**29/29**，覆盖 read/read_many、exec JSON + saveStdout、write stat、edit dryRun、jobs status/stop、forward JSON、trash JSON。
- 仓库既有探针：regression **7/7**、safety **24/24**、feature **14/14**、job **6/6**、import **3/3**、tunnel-crash **5/5**（合计 **59/59**）。
- `scripts/package.ps1 -Version 0.17.4` 生成 `dist/presence-plugin-0.17.4.zip`（1.15 MB，含 node_modules 与重建后的 client.js）。

## 〇之二十二、第二十三轮：工具返回值与新增探针（0.17.5）

来源：同一次真实客户端压测（`Presence-mcp/mcp/TOOLTEST-REPORT.md`：22 步 / 17 个工具）之后，MCP 0.2.0 的工具层修复。本轮把其中 3 个新工具与 11 项格式/行为修正移植进插件（行为参照 MCP，代码按插件自己的 `tool({...})` 与 `pickScope`/`remotePath`/`shq` 风格重写，未抄 zod）。工具数 15 → 18；默认文本输出除下列注明处外保持原样。

**新增工具**

- `presence_stat`：一次远端 `stat -c` 批量报告 1–100 个路径（类型 / 大小 / 八进制 mode / mtime），`hash:true` 时对普通文件追加 `sha256sum`；**缺失路径返回 `exists:false` / `type:"missing"`**，不让整次调用失败；符号链接默认只描述链接本身，`followSymlinks:true` 才穿透；`format:"json"` => `[{path, exists, type, sizeBytes, mode, mtimeISO, mtimeMs, sha256?}]`。
- `presence_port_probe`：一次 exec 同时取回 `ss -ltnp`（pid/process）与每个端口的 TCP 探测结果（`bash /dev/tcp`；无 bash 或无 `/dev/tcp` 时回退 python3 socket）；`ports` 1–20、`expect:"open"|"closed"`、`waitMs` 每 250 ms 轮询到满足或超时；`format:"json"` => `[{port, listening, pid, process, probe, ok}]`。
- `presence_http_probe`：一次调用完成「等远端端口 → `openForward` → 本地 `fetch` 多个 path → 断言状态码/响应体 → **finally 必关转发** → 探测本地端口已释放」；`pass` = 所有状态码命中且所有 `expectBody` 子串都出现在拼接后的响应体里；`format:"json"` => `{forwardId, localPort, remotePort, results, pass, portReleased}`。

**格式与行为**

- `presence_hosts`：`format:"json"` => `[{alias, address, user, hostname, port, source, state, connected, default}]`；文本给默认主机（当前工作区所在机器）加 `*`。
- `presence_connect`：`format:"json"` => `{host, user, hostname, kernel, arch, platform, connectedAtMs}`。
- `presence_search`：`format:"json"` => `{pattern, root, countOnly, matchCount, truncated, matches:[{file, line, column?, text}]}`。
- `presence_glob`：`format:"json"` => `[{path, sizeBytes, mtimeISO, mtimeMs}]`。
- `presence_import`：`format:"json"` => `{remotePath, localPath, sizeBytes, sha256, mode}`，sha256 完整。
- `presence_terminal`：open 新增 `cwd`/`command`（默认 bash），返回 `{terminalId, host, cwd, shell}`；write 默认返回本次输出，`ackOnly:true` 只回 ack、输出留给 read；五个动作都支持 `format:"json"`。
- `presence_jobs`：`wait` 新增 `timedOut`；运行中任务的 `status.exitSummary` 为 `null`；`stop` 新增 `port`，停止后轮询该远端端口并给出 `portReleased`（jobId 与 pgid 两条路径都支持）；`wait` 也支持 `format:"json"`。
- `presence_trash`：`action:'trash'` 新增 `paths[]`（1–50，逐项返回，单项失败不影响其余；只传 `path` 时返回形状不变）；`list` 的 JSON 每条只保留 `movedAtISO` 一个时间字段。
- `presence_edit`：`dryRun` 的 JSON 新增 `actualSizeBytes`（磁盘现值）与 `projectedSizeBytes`（编辑后大小），`sizeBytes` 在 dryRun 时等于现值、写入后等于落盘值；文本在 dryRun 时给 `dry run: X B → Y B projected`。
- `presence_write`：新增 `ifMatchSha256` 乐观锁（先读当前哈希，不匹配或读不到就报错并同时给出期望值/当前值，一个字节都不写）；文本改为打印完整 sha256。
- `presence_exec` + `src/destructive.js`：危险命令 dry-run 在 `format:"json"` 下返回 `{dryRun:true, requiresConfirm:true, targets, command, report}`；`guardDestructive` 在原有 `{kind, report, resolved}` 之外返回 `targets`（签名兼容）；修掉两条消息里的坏字节（`nothing was executed yet` / `the command would touch nothing`，现为纯 ASCII，无 U+FFFD），README 示例同步为 `): nothing was executed yet`。
- 版本：`package.json` → 0.17.5。

**验证**（server，2026-10-26）：

- `node --check src/tools.js`、`node --check src/destructive.js` 通过；`src/destructive.js` 已无任何非 ASCII 字节。
- 新增并提交 `scripts/tool-probe.mjs`：用 loader hook 把 `@deepseek-ai/dsh-tools` 映射为 stub `defineTool`，在普通 Node 下直接调用真实工具实现（参数、文本与 JSON 形状全走真实代码）→ **32/32**：
  - stat：存在/缺失/目录/符号链接、mode/sha256 与本机 `createHash` 一致、文本汇总；
  - port_probe：`expect:"closed"`、等后台 `python3 -m http.server` 起来（含 pid/process）、stop 后确认 `refused`；
  - http_probe：两个 path + `expectBody` 全中、`pass:true`、`portReleased:true`、转发列表已空；错误期望值得到 `pass:false` 但仍清理；
  - JSON：hosts / connect / search / glob / import / trash list / terminal 五动作 / write `ifMatchSha256` / edit dryRun / exec 危险命令 dry-run。
- 既有探针（串行）：regression **7/7**、safety **24/24**、feature **14/14**、job **6/6**、import **3/3**、tunnel-crash **5/5**，合计 **59/59**。
- `scripts/package.ps1 -Version 0.17.5` → `dist/presence-plugin-0.17.5.zip`，1.17 MB（含 node_modules 与重建后的 client.js；zip 内 `package.json` 为 0.17.5，且含 `scripts/tool-probe.mjs`）。

**与 MCP 0.2.0 的差异**：插件的 `presence_exec` 从来没有 `script` 模式（那是 MCP 独有的入参），因此第 14 项只覆盖 `command` 模式；`targets` 对命令模式是真实解析结果（MCP 的脚本模式返回 `[]`）。

## 一、最初提出的问题 → 现在的结果

| # | 原始要求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 所有 coding 任务集成在一台开发机上 | ✅ | agent（模型、代理、配置）只在本机跑；远端只提供执行和文件 |
| 2 | 不在每台服务器装 coding agent / 不逐台配代理 | ✅ | 远端零安装：只用 sshd 自带的 SFTP、exec、shell 通道。检查 `~/.presence`、`/tmp/presence*`、`~/.bashrc`、`~/.profile` 均无残留（早期实验留下的空目录已删除） |
| 3 | 不要每条命令重新建 ssh 隧道 | ✅ | 常驻连接：`presence_exec` 单次 13–49 ms；同样场景 `ssh host true` 每次新建连接 **495–634 ms（均值 563 ms）** |
| 4 | 用目标服务器环境自己的工具 | ✅ | 文件操作用服务器的 sshd SFTP 子系统；搜索用目标机自带的 `rg`；命令在目标机的登录 shell 里执行（`uname`/`nproc`/`tmux` 等均可用） |
| 5 | agent 效果接近本地操作 | ✅ | 内置 `read`/`write`/`edit` 直接作用于远端；文件树展开远端目录；会话 cwd 就是远端路径；agent 自己报告「我运行在 server 上，工作目录 /srv/app」 |
| 6 | 不丢失上下文、有持久环境 | ✅ | 工作区绑定持久化（`~/.dsh/presence/workspaces.json`）；连接断开后下一次调用自动重建；tmux 终端跨断线保留状态 |
| 7 | 稳定可靠，像新建标签页一样新建终端 | ✅ | `presence_terminal` open/write/read/close/list；断线后重新 open 可 reattach |
| 8 | 终端不随 ssh 断开而消失 | ✅ | 实测：tmux 会话内 `export TMUX_MARK=survives-disconnect` → 强制断开连接 → 重连并 reattach → `MARK=survives-disconnect` 仍在（滚动缓冲区完整保留）。现已做成 `open` 的 `session` 参数，自动 `tmux new-session -A` |
| 9 | 远程操作尽量和本地一样 | ✅ | 相对路径相对工作区根；写入是原子替换（无临时文件残留）；编辑有版本守卫（`FS_STALE_VERSION`）和歧义拒绝；错误码统一 |
| 10 | 后续做成 MCP 给小软件/其他 agent 用 | ⬜ 未做 | 内核（`src/core/`、`src/pool.js`）零 DSH 依赖，可直接抽出来套 stdio JSON-RPC |

## 二、后续追加的需求

| 要求 | 结果 | 证据 |
| --- | --- | --- |
| 界面上直接选服务器、要密码的输密码 | ✅ | 设置 → Presence：机器列表 → 点机器 → 按需输入密码（可「记住这台」） |
| 像本地工作区一样在远程文件夹里选 | ✅ | 面板内逐级浏览远程目录 → 「用这个文件夹」 |
| 远程文件夹成为真正的工作区 | ✅ | 左侧「工作区」列表出现；会话 cwd 是远端；文件树展开远端 |
| agent 只考虑该工作区对应的服务器 | ✅ | 每个模型步骤注入绑定上下文；`presence_*` 工具不再需要 host，相对路径自动落到工作区根 |

## 三、实测数据

| 操作 | 耗时 |
| --- | --- |
| 新建连接的 `ssh host true` | 563 ms（均值） |
| 常驻连接上的 `presence_exec` | 13–49 ms |
| 内置 `read`（挂载路径 → 远端） | 亚秒级 |
| 断线后自动重连 + 执行 | 13 ms |
| 面板状态接口 | 13 台机器 / 1 个工作区 |

## 四、已知边界（不是 bug，是设计取舍）

1. **`grep` / `glob` 看不到远程文件**：它们是原生 ripgrep，按真实路径扫描；挂载点目录在本地是空的。用 `presence_search` 代替（已写入 agent 的运行时上下文）。
2. **挂载点路径不美观**：侧边栏显示 `C:\Users\<用户>\.dsh\presence\mounts\<主机>\<远端路径>`。可用工作区标题掩盖，属改进项。
3. **终端持久化依赖目标机的 tmux**：目标机没有 tmux 时终端仍随连接存活，但断线后会丢失（不会安装 tmux，保持零安装原则）。
4. **多工作区是全局单例**：「当前工作区」同一时刻只有一个；多会话并行绑定需要 per-session 映射。
5. **只实测了一台主机**（server）。其余 12 台在列表里，但未逐个连接验证（有密码/跳板机限制）。
6. **MCP 未实现**。

## 五、部署方式

冷启动手动安装是唯一稳定路径（热装/卸会打断进行中的调用并留下半成品组合）：

```powershell
# 完全退出 DeepSeek Harness 后
powershell -ExecutionPolicy Bypass -File .\scripts\install-presence.ps1 -Mode fs -PluginRoot 'D:\04_Dev\Presence'
```

`-Mode safe` 只装工具与面板，不替换文件系统后端；`-Mode fs` 才启用远程工作区。
