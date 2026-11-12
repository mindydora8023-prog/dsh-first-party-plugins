# task-radar 审计与整改记录

日期：2026-11-12。初次审计针对本地 0.1.0，曾因材料不齐暂缓；随后按操作者要求整理为发布副本 0.1.1，加入仓库 0.3.0 批次。当前明确作为社区通知引擎改编作品分发，不重新归类为全原创。

## 来源与许可

| 来源 | 固定复核提交 | 判断与处理 |
|---|---|---|
| Pasumao/dsh-plugin-notify | [a802f00f4f9cc59893ec1df2218faf91552d8386](https://github.com/Pasumao/dsh-plugin-notify/tree/a802f00f4f9cc59893ec1df2218faf91552d8386) | 通知引擎主干成组改编；保留 Copyright (c) 2026 Pasumao 和完整 MIT |
| c-ling/dsh-plugin-notify | [69cf298af2e241a9d83b3320214c413c0dc946cd](https://github.com/c-ling/dsh-plugin-notify/tree/69cf298af2e241a9d83b3320214c413c0dc946cd) | 旧文档记录参考，少量通用助手相似；保守保留 Copyright (c) 2026 chenchao 与完整 MIT，不声称采用其完整 Webhook 实现 |
| ltao0829/dsh-task-notify | [6735fd29909edc9e2f0531a52d671b2d9e607bcf](https://github.com/ltao0829/dsh-task-notify/tree/6735fd29909edc9e2f0531a52d671b2d9e607bcf) | 功能参考；未确认完整模块复制；记录其 BSD-3-Clause 来源链接，不把未分发代码的许可证套给本包 |

固定提交是可复核基准，不代表已经恢复最初移植时的精确版本。每个独立运行包包含 [THIRD_PARTY_NOTICES.md](../plugins/task-radar/THIRD_PARTY_NOTICES.md)、主 MIT 及适用的上游许可原文。

## 已核实的通知引擎对应

以下本地行号指整改前 0.1.0；发布版因注释与发送器重构已变化。

| 原本地代码 | 固定 Pasumao 上游 | 内容 |
|---|---|---|
| index.js:75–91 | [index.js:71 起](https://github.com/Pasumao/dsh-plugin-notify/blob/a802f00f4f9cc59893ec1df2218faf91552d8386/lib/index.js#L71) | PowerShell 路径、图标定位、环境过滤，同名同序 |
| index.js:93–144 | [index.js:103 起](https://github.com/Pasumao/dsh-plugin-notify/blob/a802f00f4f9cc59893ec1df2218faf91552d8386/lib/index.js#L103) | WinRT XML、位置行、AUMID、EncodedCommand、子进程参数 |
| index.js:153–225 | [index.js:162 起](https://github.com/Pasumao/dsh-plugin-notify/blob/a802f00f4f9cc59893ec1df2218faf91552d8386/lib/index.js#L162) | 工作区/会话标签、标题回退、摘要、问题提取 |
| index.js:263–278、321–416 | [index.js:369 起](https://github.com/Pasumao/dsh-plugin-notify/blob/a802f00f4f9cc59893ec1df2218faf91552d8386/lib/index.js#L369) | running/waiting 状态、结束门控、按 callId 清等待、启动播种和监听器清理 |

c-ling 的 dshHome、bool/str 等短助手相似不足以证明整模块复制。ltao 的客户端快照差分与本地主机事件状态机不同；相同 Notification API 或授权手势也不足以单独证明复制。原文“取经”表述已改为按实际代码范围署名。

共享 `lib/state-dir.js` 来自本工作区自身共享助手，与上述社区通知引擎分开记录。

## 图标处理

初次检查的旧 PNG 没有来源元数据，旧 SVG 与 PNG 也未证明有确定生成关系。与上游鲸鱼图标哈希不同只证明字节不同，不能据此认证原创。

发布版不携带两张旧图。新 `tools/build-icons.mjs` 是本次编写的源稿，用同一几何模型输出 SVG 与 PNG：圆角底板、同心圆、扇形、扫描线及目标点；无外部图片或字体。PNG 编码使用 Node.js 内置 zlib 和自编 CRC/容器写入，具有逐字节 `--check`。生成器和两种图标均随发布包提供。

## 打包与文档整改

- 原 files 白名单漏 assets/icon.png；发布清单已包含 assets、SVG、生成器、来源声明和两份上游许可。
- 根发行检查新增 assets 白名单检查，CI 运行图标再生一致性检查。
- 移除 bundle 注释和 README 中尚未实现的 Webhook/HMAC/密文接口/自定义音效宣传，仅保留 Windows Toast 和浏览器系统通知真实能力。
- 测试按钮只提交已保存配置下的 Windows 请求，不向浏览器 journal 注入模拟事件；成功响应不作为系统实际显示的证明。文案和文档均对齐此限制。
- 运行时增加可替换发送器，用于离线验证；默认发送仍走原 Windows 通道，实际子进程有超时。
- 旧 wire 测试会启动真实 Toast、依赖 TEMP 并只断言日志；替换为捕获发送调用和参数的测试，使用独立临时目录并清理环境与监听器。

## 验证边界

自动验证覆盖配置、事件流、Windows 发送参数、环境过滤、默认 PNG、浏览器通知和点击接线、打包文件及图标再生；通过替身运行，不会发送真实系统通知。Windows 通知中心是否实际弹出、浏览器权限/后台调度表现仍应在目标系统手动验证。

活动安装源码与现有用户配置未修改，本次改动仅在开源仓库发布副本中生效。历史退役的 codex-quota、session-title-first-round 不在此插件整理范围。
