# 代码与素材来源

本插件在工作区开发多文件读取接线、预算与渲染逻辑，含下列可明确核对的上游改编部分。自开发贡献与上游部分均按各自 MIT 声明分发。

## DeepSeek

`lib/define.js` 为对宿主工具参数编译与校验行为的兼容移植，来自本工作区共享模块。核验版本为 @deepseek-ai/dsh-tools 0.2.2-rc.1。

- [上游项目](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/core/tools)。
- Copyright (c) 2026 DeepSeek。
- [完整 MIT 文本](licenses/deepseek-dsh-tools-MIT.txt)。

## T-Auto / dsh-ops

- `lib/compact.js` 明确注明改编 `src/modes/native/ranges.ts` 与 `docs/file-batching.md`。
- `lib/outcome.js` 明确注明改编 `src/kernel/outcome.ts` 与 `src/kernel/errors.ts`。
- Copyright (c) 2026 T-Auto and the dsh-ops contributors。
- [完整 MIT 许可正文](licenses/dsh-ops-MIT.txt)。

复核用固定版本：[186a8fe6ca37d9f91a3cd9635c33e3a60e6ec664](https://github.com/T-Auto/dsh-ops/tree/186a8fe6ca37d9f91a3cd9635c33e3a60e6ec664)。该版本用来复核对应逻辑与许可，不表示已证明最初移植时恰好采用这个提交。

上游 LICENSE 末尾还说明整套发行物包含 FastCtx 等其他许可组件。本插件未分发 FastCtx、Niubash、Rust 载荷或上游完整工具集合；因此只携带实际涉及的 MIT 正文，不机械复制整套上游发行物的组合许可结论。

## 其余素材

`lib/state-dir.js` 为工作区共享助手。图标为三张叠页的内联 SVG，没有外部图片或字体；本次未发现现成图标包引用，早期创作记录尚未独立追溯。
