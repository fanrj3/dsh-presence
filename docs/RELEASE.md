# Presence 发布说明（Release）

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
