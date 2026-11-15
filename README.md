# Grok Bot 换壁纸背景

兄弟姐妹们，我开源了一个新项目—— **Grok Bot 换壁纸背景**。

你是不是早已经看腻了 Grok Bot 默认的黑白面板？现在，你可以任意上传一张喜欢的壁纸，设成 Grok Bot 的背景。

![在 Grok Bot 窗口里换壁纸、调整透明度](docs/screenshot.jpg)

介绍帖：[Grok Bot 换壁纸背景](https://x.com/KinGao476942/status/2121763505665876302)

## 怎么用

操作很简单：

1. 把这句话发给你的 Agent：「帮我安装这个 Grok Bot 换壁纸的项目：https://github.com/KinGao294/grokbot-wallpaper」
2. 在悬浮窗口点「上传壁纸」，选一张不超过 4MB 的图片（支持 png / jpg / webp），就会设成背景。
3. 在悬浮窗口拖动滑条，调整壁纸透明度。面板可以拖走，免得挡住输入框。

欢迎点赞收藏 Star，赶紧试试吧。

## 使用前先看这几句

- 目前只支持 **Mac** 上的 Grok Bot 桌面应用。
- 这是本机覆盖层，不是官方主题，也不会改官方应用、安装包或签名。
- 第一次安装时，可能需要重启一次 Grok Bot，当前聊天窗口会关掉。之后换图、调透明度都不用再重启。
- 完全退出应用后，覆盖层会先消失；登录后助手会自动启动，如果 Grok Bot 带着本机调试口打开，会尽量自动换上上次的壁纸。
- 调试接口只绑在本机 `127.0.0.1`，不要做端口转发。

图片副本存在 `~/Library/Application Support/grokbot-wallpaper/`，原图不会被删，也不会传到网上。默认透明度是 0.9，可在 0.15 到 1 之间调。

## 自己在终端安装

需要 Node.js 22+。在仓库目录里执行：

```bash
node scripts/grokbot-wallpaper.mjs help
node scripts/grokbot-wallpaper.mjs status
node scripts/grokbot-wallpaper.mjs apply "/absolute/path/photo.png" --opacity 0.9 --dark
```

如果还没开本机调试端口，上面这条会先退出，不会关应用。你保存好当前工作并同意重启后，再执行：

```bash
node scripts/grokbot-wallpaper.mjs apply "/absolute/path/photo.png" --relaunch
```

已经开过调试端口时，只会注入壁纸，不会退出应用。恢复原来的界面：

```bash
node scripts/grokbot-wallpaper.mjs restore
```

`apply` 成功后，会装上登录自启。也可以单独运行 `watch` 或 `panel`。

给助手看的详细步骤在 [SKILL.md](SKILL.md)。
