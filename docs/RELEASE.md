# Presence 发布说明（Release）

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
