# Grok Bot 换背景

一个可复用技能和零 npm 依赖的 Node.js 22+ CLI，在 Mac 上用用户图片创建本机壁纸覆盖层。官方设置只有 Light/Dark/Accent；这不是官方主题，不修改应用包、app.asar 或签名。

在本目录执行：

```bash
node scripts/grokbot-wallpaper.mjs help
node scripts/grokbot-wallpaper.mjs status
node scripts/grokbot-wallpaper.mjs apply "/absolute/path/photo.png" --opacity 0.45 --dark
node scripts/grokbot-wallpaper.mjs apply "/absolute/path/photo.jpg" --opacity 0.6 --light
node scripts/grokbot-wallpaper.mjs restore
node scripts/grokbot-wallpaper.mjs panel
```

首次未开启调试端口时，apply 以状态码 2 退出，不关闭应用。保存当前工作并确认允许重启后，再执行：

```bash
node scripts/grokbot-wallpaper.mjs apply "/absolute/path/photo.png" --relaunch
```

重启会关闭当前聊天窗口。已经开启调试端口时只注入。

进程是否在跑用 osascript 和 `ps` 判断，不用 `pgrep -x`（主进程名带空格时会漏检，从而误开第二个实例）。带调试端口启动用 `open -a ... --args`，不要直接跑 `Contents/MacOS/Grok Bot`，否则系统可能再拉起一份、丢掉参数。支持 PNG/JPG/JPEG/WebP；超过 4MB 会尝试用 sips 缩小为 JPEG，否则明确报错。透明度范围 0.15–0.85，越大照片越明显，默认 0.45、深色。

应用成功后，窗口右下角会出现本机悬浮面板：可直接选择图片，并用滑条调整透明度（0.15–0.85）。选图和调透明度由本机 `127.0.0.1:19223` 助手保存，不要转发该端口。面板可收起。`apply` 会在需要时自动启动助手；也可单独运行 `panel`。

图片副本与状态保存在 `~/Library/Application Support/grokbot-wallpaper/`，原图保留。图片通过 data URL 嵌入，不发布到网络。覆盖层使用运行时表面识别，实际效果随界面布局变化；当前进程重载时注册的脚本用于重新应用，完全退出应用后失效，新窗口可再次运行 apply。restore 会恢复记录的样式并移除已记录的重载脚本，不删除图片。

安全：本机调试端口允许同一电脑上的其他进程访问 Grok Bot 窗口，只使用 `127.0.0.1:19222` 和 `127.0.0.1:19223`，不要端口转发。远程助手应把 helper 和图片复制到用户 Mac 后在 Mac 上执行，不能在远程机器操作该端口。

助手操作步骤见 [SKILL.md](SKILL.md)。
