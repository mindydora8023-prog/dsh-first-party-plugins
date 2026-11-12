# 共享助手

`define.js` 为本工作区统一维护的工具定义实现，注明对 DSH 参数编译与校验行为的移植。适用上游为 @deepseek-ai/dsh-tools，核验安装版本 0.2.2-rc.1，Copyright (c) 2026 DeepSeek；[完整 MIT](licenses/deepseek-dsh-tools-MIT.txt)。

`state-dir.js` 为工作区开发的状态目录助手。各插件携带自己的运行时副本，不跨包依赖此目录。此目录为源码与一致性检查使用，不是独立 DSH 插件。
