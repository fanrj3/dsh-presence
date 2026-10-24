# Presence 手动安装说明

这个包里已经带了运行时依赖（`node_modules/ssh2`），**不需要联网、不需要 npm**。

## 为什么用手动安装

之前几次失败都发生在「应用运行中装/卸插件」——那会触发整个插件组合的热重载，重载窗口里任何进行中的操作都会被打断，profile 可能停在中间态。

手动安装是把组合改动一次性写好，**冷启动**时再由 loader 统一挂载，没有重载窗口，也就没有中间态。

## 安装

1. **完全退出 DeepSeek Harness**（托盘也要退出，确认任务管理器里没有 `DeepSeek Harness.exe`）
2. 把压缩包解压到一个固定目录，例如：`D:\04_Dev\Presence`
3. 打开 PowerShell，在解压目录里执行：

   ```powershell
   # 安全模式：只加工具和面板，不碰全局文件系统
   powershell -ExecutionPolicy Bypass -File .\scripts\install-presence.ps1 -Mode safe

   # 或者完整模式：额外让远程文件夹成为真正的 DSH 工作区
   powershell -ExecutionPolicy Bypass -File .\scripts\install-presence.ps1 -Mode fs
   ```

4. **启动 DeepSeek Harness**

## 验证

- 设置 → Presence：能看到服务器列表 → 选机器 → 浏览远程目录 → 建工作区
- `-Mode fs` 额外验证：左侧「工作区」里出现该远程工作区；在它里面新建会话，文件树能展开远程目录；内置 `read` 能读远程文件

## 如果出问题

```powershell
# 先完全退出应用，再执行
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-presence.ps1
```

然后重启应用。卸载会把 profile 恢复成安装前的样子（`fs-sandbox` 等出厂插件会回来），并把这个目录里的默认补丁切回安全模式。

`-Mode fs` 的已知风险：如果 `presence-fs` 那一行没起来，整个 `ctx.fs` 会消失，表现为**新建会话失败**（`sessionController is unavailable`）。当前会话不受影响。遇到就跑上面的卸载脚本。

## 目录说明

```
index.js                插件入口（工具 + 面板 API + 运行时上下文）
client.js               浏览器面板
cordis.patch.yml        当前生效的补丁模式（安装脚本会覆盖它）
presets/safe.patch.yml  安全模式补丁
presets/fs.patch.yml    完整模式补丁
src/core/               一条常驻 SSH 连接：SFTP / exec / PTY
src/fs-provider.js      presence:// 文件系统提供方（仅 fs 模式使用）
docs/HANDOFF.md         完整技术交接文档（含隔离环境验证方法）
```
