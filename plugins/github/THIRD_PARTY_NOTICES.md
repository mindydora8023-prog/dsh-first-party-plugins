# 代码与素材来源

本插件的 GitHub REST API 封装、凭据来源选择、代理处理和工具注册接线在本工作区开发。MIT 主许可证覆盖本地贡献；下列上游部分保留原权利人的声明。

## DeepSeek 宿主兼容实现

`lib/define.js` 从工作区共享实现复制，其注释明确记录了对 DSH 参数编译器和参数校验行为的移植。按改编来源保留：

- 上游：[@deepseek-ai/dsh-tools](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/core/tools)，本次核验安装版本 0.2.2-rc.1。
- 版权：Copyright (c) 2026 DeepSeek。
- 许可：[完整 MIT 文本](licenses/deepseek-dsh-tools-MIT.txt)。

该说明不将插件认定为宿主整包副本，也不把宿主未随本包分发的依赖加入许可清单。

## 图标

发布版 `icon.svg` 是本次发布整理时新写的分支与节点几何图。原工作区图标包含 GitHub Invertocat 轮廓，未随本发布包收录。新 SVG 是其可编辑源稿，不使用 GitHub 品牌图形。

GitHub 服务名称用于说明集成功能，本插件并非 GitHub 官方产品。
