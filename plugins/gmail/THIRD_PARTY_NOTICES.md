# 代码与素材来源

本插件在工作区实现 IMAP/SMTP 客户端、MIME 处理、工具注册和配置。运行时只使用 Node.js 内置模块。协议名称与标准字段本身不代表引用了协议库实现。

`lib/define.js` 为工作区共享工具定义助手，注明对 DSH 宿主参数编译和校验行为的移植，保守作为上游改编披露：

- 上游：[@deepseek-ai/dsh-tools](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/core/tools)，核验版本 0.2.2-rc.1。
- Copyright (c) 2026 DeepSeek。
- [完整 MIT 许可证](licenses/deepseek-dsh-tools-MIT.txt)。

`lib/state-dir.js` 为本工作区共享助手。`icon.svg` 是信封矩形与折线组成的可编辑几何图；本次未发现外部图片或字体嵌入，也未找到其更早创作记录，不将静态检查等同于完整作者历史证明。

本包不携带工作区独立的 Python CLI 与 Windows 启动器，安装和凭据说明只适用于本插件。Gmail 名称仅用于说明服务集成。
