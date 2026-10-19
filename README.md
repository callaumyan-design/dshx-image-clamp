# dshx-image-clamp

> Downscales every image sent to the model so its long edge is at most 2000px (and under a byte budget), avoiding Claude's many-image limit that otherwise breaks the whole session.

Claude 在一次请求里图片超过 20 张时，任何一张边长超过 2000px 就会整条请求被拒。DSH 的附件归一化只限制总像素，单边仍可能超过 2000（例如 2730×1536），之后每一轮都会重放这张图，整个会话就卡死了。

本插件包装 `attachments.readImage`，在图片发给任何 provider 之前**实时**缩小到长边 ≤ `maxSide`，并压到单张 `maxBytes` 以内。磁盘上的原图不改动，停用插件即完全还原。

## 配置（`cordis.patch.yml`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `maxSide` | `2000` | 长边上限（像素） |
| `maxBytes` | `184320` | 单张编码后字节上限（180 KB） |

依赖宿主已有的 `sharp`（DSH 自带）；找不到时插件会记录警告并不做处理。

## 安装

```sh
# Web profile
dsh plugin --profile web add github:callaumyan-design/dshx-image-clamp
# Desktop（用 DSH Desktop 自带的 dsh 命令，先从托盘完全退出 Desktop）
dsh plugin --profile desktop add github:callaumyan-design/dshx-image-clamp
```

安装后重启 DSH。卸载：`dsh plugin --profile <profile> remove dshx-image-clamp`。

## 兼容性

在 DeepSeek Harness 0.2.0-rc.2（desktop / web profile）上开发和使用。纯 JavaScript，无构建步骤，无安装脚本。

## License

MIT
