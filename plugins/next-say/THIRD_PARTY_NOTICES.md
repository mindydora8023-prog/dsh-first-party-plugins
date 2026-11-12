# 第三方来源与许可

next-say 是包含上游辅助逻辑改编的 DSH 插件，不声明全部实现均为独立原创。

## dsh-prompt-predict

- 上游：[ferrisching/dsh-prompt-predict](https://github.com/ferrisching/dsh-prompt-predict)。
- 审计对照版本：提交 `ded6c292b4347a47825520ef54b5b20ca53e8bd7`（0.2.7）；这是用于标记可复核内容的固定版本，不宣称已经恢复最初复制时使用的精确提交。
- 对照源码：[lib/predict.mjs](https://github.com/ferrisching/dsh-prompt-predict/blob/ded6c292b4347a47825520ef54b5b20ca53e8bd7/lib/predict.mjs)。
- 许可：MIT，`Copyright (c) 2026 ferrisching`。
- 原始完整许可：[licenses/dsh-prompt-predict-MIT.txt](./licenses/dsh-prompt-predict-MIT.txt)，与[固定版本 LICENSE](https://github.com/ferrisching/dsh-prompt-predict/blob/ded6c292b4347a47825520ef54b5b20ca53e8bd7/LICENSE)对应。

本地 [lib/predict.js](./lib/predict.js) 按上游改编处理，具体包括：预测提示词表达、文字系统和逐消息语言投票、字符到 token 的预算估算、历史消息提取与裁剪、输出包装清理、会话模型路由回退、历史帧化及避免重复建议的提示文字。

可复核的组合证据包括：上游提示词第 11–24 行的连续句段；第 75–85 行的 `0.6` / `2.5` 估算；第 123–139 行的投票和同票取较新消息；第 170–188 行的默认 `8 / 6000 / 1600`、反向遍历、每条 `+32` 和首条超预算保留规则。本地在这些基础上增加引用材料剔除、拉丁按词计数、繁体识别、更宽的推理预算和近似重复判断等调整。

本地宿主路由与请求接线、历史前缀补全、ghost 排版、设置页和构建测试是本插件的集成与开发工作。该说明不将共享功能、通用宿主 API 或审计未覆盖的创作历史当成全面原创证明。

再分发改编代码时，请同时保留上游版权声明和完整 MIT 许可；插件自身的 MIT 许可见 [LICENSE](./LICENSE)。本文件与 `licenses/` 已列入运行包白名单。
