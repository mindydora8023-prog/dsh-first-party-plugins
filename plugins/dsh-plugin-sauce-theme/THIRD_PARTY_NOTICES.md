# 第三方来源与许可

## Catppuccin Latte

本插件实际采用 Catppuccin Latte 调色板，并将颜色映射到 DSH 对话标题、链接、引用块和语法 token；这是第三方配色素材的使用。

- 上游：[catppuccin/palette](https://github.com/catppuccin/palette)。
- 固定审计版本：`07d02aa110ef9eb7e7427afca5c73ba9cf7f8ebd`（1.8.0）。
- 调色板：[palette.json](https://github.com/catppuccin/palette/blob/07d02aa110ef9eb7e7427afca5c73ba9cf7f8ebd/palette.json)。
- 许可：MIT，`Copyright (c) 2021 Catppuccin`。
- 原始完整许可：[licenses/Catppuccin-MIT.txt](./licenses/Catppuccin-MIT.txt)，对应[固定版本 LICENSE](https://github.com/catppuccin/palette/blob/07d02aa110ef9eb7e7427afca5c73ba9cf7f8ebd/LICENSE)。

[client.js](./client.js) 中的实际映射：mauve `#8839ef`、peach `#fe640b`、blue `#1e66f5`、green `#40a02b`、overlay1 `#8c8fa1`、yellow `#df8e1d`、overlay2 `#7c7f93`、sky `#04a5e5`。

DSH 的样式选择器、设置开关、字体范围和外观恢复逻辑是本插件的集成实现；这不等于对全部代码创作历史作出原创认证。当前包没有第三方图像或字体文件；[icon.svg](./icon.svg) 是可编辑的终端提示符和酱滴几何组合，静态审计本身不证明绘制过程。字体名称只是系统回退列表，未分发相应字体。

再分发时请保留 Catppuccin 版权和完整 MIT 许可。插件自身的 MIT 许可见 [LICENSE](./LICENSE)；本说明及 `licenses/` 已列入运行包白名单。
