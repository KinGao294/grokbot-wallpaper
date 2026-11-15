---
name: Grok Bot 换背景
description: use this when the user uploads an image and wants to change the Grok Bot desktop app background, wallpaper, or skin.
---

# Grok Bot 换背景

当用户上传图片，希望更换 Mac 上 Grok Bot 桌面应用背景、壁纸或皮肤时使用。官方设置只有 Light/Dark/Accent，没有壁纸 API。本技能通过本机 Electron 调试连接添加临时页面覆盖层。

## 硬规则

- 不修改官方 `Grok Bot.app`、`app.asar` 或签名。
- 不发布图片，不上传到图床，不删除用户原图。仅保存上传附件，以及为本机使用所需的副本。
- 调试端口仅使用 `127.0.0.1:19222`，面板助手仅绑定 `127.0.0.1:19223`。不得绑定公网地址或转发这两个端口。
- 未经用户确认，不得退出或重启 Grok Bot。请求换背景本身不代表同意重启；重启会关闭当前聊天窗口。
- 用户要求恢复时，运行 `restore`，不要再次应用壁纸或擅自重启。

## 操作步骤

1. 将上传图片保存为本地文件，支持 PNG、JPG、JPEG、WebP。保留原文件。
2. 所有应用命令必须在用户的 Mac 上执行，要求 Node.js 22+。如果助手运行在远程机器，使用已获授权的文件传输方式把图片与本技能的 helper 复制到用户 Mac；没有 Mac 连接时提供命令让用户执行，不要在远程机器连接调试端口，也不要建立端口转发。
3. Helper 位于本技能旁的相对路径 [`scripts/grokbot-wallpaper.mjs`](scripts/grokbot-wallpaper.mjs)。在技能目录运行，含空格的路径必须加引号：

   ```bash
   node scripts/grokbot-wallpaper.mjs status
   node scripts/grokbot-wallpaper.mjs apply "/absolute/path/photo.png" --opacity 0.9 --dark
   ```

   `--light` 可改用浅色外观；默认深色。透明度参数限制在 0.15–1，默认 0.9，数值越大照片越明显。超过 4MB 的图片会尝试用 macOS `sips` 缩小为 JPEG，仍过大或工具不可用时会拒绝。副本为 `~/Library/Application Support/grokbot-wallpaper/current.<扩展名>`。
4. 如果 CLI 因调试端口未开启而以状态码 2 退出，向用户解释：“第一次换背景需要重启一次 Grok Bot，开启仅本机可用的调试端口。重启会关闭当前聊天窗口，请先保存当前工作。”取得重启确认后，才可执行：

   ```bash
   node scripts/grokbot-wallpaper.mjs apply "/absolute/path/photo.png" --opacity 0.9 --dark --relaunch
   ```

   如果用户已明确确认本次重启，无需重复询问。端口已经开启时 helper 只注入，不退出应用。不要用额外的退出命令绕过此边界。

判断应用是否在运行时不要用 `pgrep -x "Grok Bot"`，改用 osascript 或 `ps` 匹配主程序路径。重启时用 `open -a` 传 `--args`，不要直接启动主二进制，以免 Launch Services 再拉起一份并丢掉调试参数。
5. 以 CLI 成功结果为依据报告：给出实际应用图片的绝对路径，并说明“这是本机覆盖层，不是官方主题”。覆盖层仅针对当前进程，完全退出后需重新应用；新窗口可能需要再次运行 apply。应用成功后右下角有悬浮面板，用户可点「上传壁纸」换图并拖动透明度滑条；登录自启由 apply 安装；助手保存到 `~/Library/Application Support/grokbot-wallpaper/`。`status` 里的 `panel` 为 true 表示助手在跑。页面透明化使用运行时几何与背景颜色判断，不能保证每个应用版本布局都完美；若显示不合适，调整透明度或恢复，不修改官方文件。

## 恢复

在同一台 Mac、同一用户下执行：

```bash
node scripts/grokbot-wallpaper.mjs restore
```

Helper 移除当前页面的壁纸层与样式，恢复记录过的内联背景属性，并移除记录的重载注入脚本；成功后将 `last-applied.json` 标记为已恢复。原图与缓存副本保留。若调试端口已关闭，明确说明无法验证或修改当前窗口，不声称已恢复；用户手动完全退出应用也会清除进程内覆盖层。恢复失败时报告错误，不擅自重启。

安全提示：回环调试端口允许同一台电脑上的其他进程访问 Grok Bot 窗口；保持绑定 `127.0.0.1`，不要转发端口。
