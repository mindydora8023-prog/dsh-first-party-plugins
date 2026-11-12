# 代码酱主题

DSH Web 的浅色对话主题：Catppuccin Latte 配色、等宽正文和语法高亮。启用时将内置外观切到浅色；关闭开关时恢复记录的 Light / Dark / System 偏好。设置页与其它结构界面沿用宿主主题。

## 使用

在 DSH 的插件安装入口使用本地包路径，或将此包作为现有 profile 的本地依赖安装。包内的 `cordis.patch.yml` 提供插件注册行；安装方式以所用 DSH 版本为准。

设置 → 通用：

- **代码酱主题**：开 / 关，默认开。
- **字体范围**：正文 / 全局，默认正文。全局选项会把站内其它控件也改为等宽字体。

偏好保存在当前浏览器的 localStorage；更换浏览器或清理站点数据后恢复默认。字体按本机可用字体回退，包内未附字体。

## 实际样式

- H1 / H2 使用 mauve，H3 使用 peach，较低级标题使用宿主灰色。
- 链接使用 blue，悬停使用 mauve；引用块使用 mauve 左边线和淡色背景。
- 正文颜色沿用宿主，加粗主要改变字重。
- 代码语法 token 使用 Catppuccin Latte 色值。
- 输入区上下文占用控件的字号对齐到 12px。

当前实现只有浅色对话配色。主题开关、字体范围及配色属于独立插件集成；配色来源和完整通知见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## 文件和验证

- `client.js`：客户端设置、样式和内置外观切换。
- `index.js`：宿主入口空壳。
- `locale/`：插件元数据。
- `icon.svg`：可编辑 SVG 几何图标。

```sh
node --check index.js
node --check client.js
```

本包没有构建步骤和外部运行依赖。源码审查和语法检查不替代真实浏览器验证；宿主升级后应检查对话标题、代码、开关恢复及两种字体范围。部分 CSS 依赖 DSH 的 DOM 标记与类名，宿主结构变化可能需要适配。

## 来源与许可

插件使用 MIT，见 [LICENSE](./LICENSE)。Catppuccin 配色保留 `Copyright (c) 2021 Catppuccin` 及[完整 MIT 许可](./licenses/Catppuccin-MIT.txt)。本包未分发第三方图片和字体；SVG 源码可编辑，但本项目不以静态审计结果宣称已经证明所有素材的创作历史。
