# 任务雷达的代码与素材来源

Task Radar 是包含社区通知引擎改编的插件，不表述为全部独立原创。主 LICENSE 覆盖本工作区贡献；下列部分保留原权利人的版权与许可。文中固定提交用于复核，不表示已经恢复最初采用代码时的精确版本。

## Pasumao / dsh-plugin-notify

- 上游：[Pasumao/dsh-plugin-notify](https://github.com/Pasumao/dsh-plugin-notify)。
- 复核版本：[a802f00f4f9cc59893ec1df2218faf91552d8386](https://github.com/Pasumao/dsh-plugin-notify/tree/a802f00f4f9cc59893ec1df2218faf91552d8386)。
- Copyright (c) 2026 Pasumao，MIT。
- [随包完整许可](licenses/Pasumao-MIT.txt) · [固定上游 LICENSE](https://github.com/Pasumao/dsh-plugin-notify/blob/a802f00f4f9cc59893ec1df2218faf91552d8386/LICENSE)。

`lib/index.js` 的以下部分按上游改编处理：PowerShell 路径与环境过滤、WinRT Toast XML/EncodedCommand 发送、工作区与会话标签回退、摘要与问题提取、运行/等待/结束事件的通知状态机、启动播种及监听器清理。

本地调整包括配置模型、事件开关、常驻选项、同源 HTTP journal、浏览器通知与设置集成。本次发布又加入可替换的发送器以便离线测试、有界子进程等待、测试修正、原创生成图标及完整来源材料。改动不消除上游署名。

## c-ling / dsh-plugin-notify

- 复核版本：[69cf298af2e241a9d83b3320214c413c0dc946cd](https://github.com/c-ling/dsh-plugin-notify/tree/69cf298af2e241a9d83b3320214c413c0dc946cd)。
- Copyright (c) 2026 chenchao，MIT。
- [随包完整许可](licenses/chenchao-MIT.txt) · [固定上游 LICENSE](https://github.com/c-ling/dsh-plugin-notify/blob/69cf298af2e241a9d83b3320214c413c0dc946cd/LICENSE)。

旧文档明确记录参考该项目；`lib/config.js` 的布尔/字符串归一化助手及 `lib/index.js` 的宿主目录助手有短片段相似。短通用片段不足以证明整模块复制，但为保留已记录的可能来源，本发行物保守附其 MIT 声明。本地没有其完整 Webhook/HMAC/密文接口实现。

## ltao0829 / dsh-task-notify：功能参考

旧文档还参考了 [6735fd29909edc9e2f0531a52d671b2d9e607bcf](https://github.com/ltao0829/dsh-task-notify/tree/6735fd29909edc9e2f0531a52d671b2d9e607bcf) 的通知体验。该上游为 [BSD-3-Clause](https://github.com/ltao0829/dsh-task-notify/blob/6735fd29909edc9e2f0531a52d671b2d9e607bcf/LICENSE)。

本次比较未确认其客户端快照检测算法或完整通知模块被移植到这里；浏览器 Notification API 使用和权限手势等相同概念，不单独证明复制。故将其记录为功能参考，不把未分发代码的许可机械套给整个插件。未来若引入其受保护代码，应同时保留适用的 BSD 完整条款。

## 共享状态目录助手

`lib/state-dir.js` 与本工作区共享模块相同，在每个插件内携带，不依赖其他插件的源码路径。

## 新图标

本次发布未使用旧工作区的 SVG/PNG 或 Pasumao 的鲸鱼图标。`tools/build-icons.mjs` 是本次编写的几何设计及 PNG 编码源：圆角底板、三个同心圆、扫描扇形、扫描线和目标点。它同时生成 `icon.svg` 与 `assets/icon.png`；源稿、输出和 `--check` 均随源码提供。

图标只使用 Node.js 内置 zlib 与自编 PNG/CRC 写入，不引用字体、第三方图像、素材包或在线服务。本地贡献按主 MIT 分发。
