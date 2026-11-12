# task-radar 代码与素材来源审计

审计日期：2026-11-12。结论基于本地 0.1.0 源码与下列固定提交的只读比较，未执行插件、真实通知或发布操作。

**本批暂缓收录 task-radar：其主机端通知引擎主体为社区项目改编，另有图标创作来源未核实、打包遗漏与功能宣传偏差。** 这与对自开发插件中边界清楚的小范围兼容模块补许可后发布不同，不是以“提到第三方”一律排除。MIT 许可兼容不是暂缓原因；Pasumao 的 MIT 允许保留声明后分发改编作品。本批先完成其他插件，后续可按下文独立整理该衍生插件。

## 固定上游与许可

| 上游 | 固定提交 | 许可证与版权声明 |
|---|---|---|
| Pasumao/dsh-plugin-notify | `a802f00f4f9cc59893ec1df2218faf91552d8386` | [MIT 原文](https://github.com/Pasumao/dsh-plugin-notify/blob/a802f00f4f9cc59893ec1df2218faf91552d8386/LICENSE)；Copyright (c) 2026 Pasumao |
| c-ling/dsh-plugin-notify | `69cf298af2e241a9d83b3320214c413c0dc946cd` | [MIT 原文](https://github.com/c-ling/dsh-plugin-notify/blob/69cf298af2e241a9d83b3320214c413c0dc946cd/LICENSE)；Copyright (c) 2026 chenchao |
| ltao0829/dsh-task-notify | `6735fd29909edc9e2f0531a52d671b2d9e607bcf` | [BSD-3-Clause 原文](https://github.com/ltao0829/dsh-task-notify/blob/6735fd29909edc9e2f0531a52d671b2d9e607bcf/LICENSE)；Copyright (c) 2026, dsh-task-notify contributors |

以上提交是本次比对基线，不代表已查明最初采用上游代码时的版本。README 的“取经”描述也不单独证明或排除复制。

## 代码：主干改编与功能参考应分开记录

Pasumao 对应部分包含多个同名函数、相同排列与细节回退路径，覆盖通知引擎主干。改动包括环境变量改名、配置拆分、常驻开关、事件归类调整，以及新增浏览器通知与 HTTP journal。分号、可选链或中文转义的改写不改变这些来源对应关系。

| 本地证据位置 | 固定上游证据 | 对应内容 |
|---|---|---|
| `task-radar/lib/index.js:75–91` | [Pasumao 主机代码，第 71 行起](https://github.com/Pasumao/dsh-plugin-notify/blob/a802f00f4f9cc59893ec1df2218faf91552d8386/lib/index.js#L71) | PowerShell 绝对路径、默认图标定位、按相同正则清洗子进程环境；函数同名同序 |
| `task-radar/lib/index.js:93–144` | [Pasumao Toast，第 103 行起](https://github.com/Pasumao/dsh-plugin-notify/blob/a802f00f4f9cc59893ec1df2218faf91552d8386/lib/index.js#L103) | WinRT 加载、XML 与位置行、PowerShell AUMID、UTF-16LE EncodedCommand、spawn 参数成组对应 |
| `task-radar/lib/index.js:153–225` | [Pasumao 辅助函数，第 162 行起](https://github.com/Pasumao/dsh-plugin-notify/blob/a802f00f4f9cc59893ec1df2218faf91552d8386/lib/index.js#L162) | 路径末段、工作区匹配、sessionTitle → 逆序标题事件 → 短 ID 回退、位置行、摘要及问题提取，六个函数同名同序且保留多处相同常量 |
| `task-radar/lib/index.js:263–278`、`:321–416` | [Pasumao 生命周期，第 369 行起](https://github.com/Pasumao/dsh-plugin-notify/blob/a802f00f4f9cc59893ec1df2218faf91552d8386/lib/index.js#L369) | running/turnStarted/waiting 状态、running → idle 门控、按 callId 清等待、会话关闭兜底、启动播种和三事件清理同构 |

c-ling 的 Webhook、HMAC 和密文接口是 README 声明的参考方向，当前本地实现中未发现这些完整模块。本地 `task-radar/lib/index.js:44–46` 的 dshHome 与 `task-radar/lib/config.js:55–61` 的 bool/str 等短片段，与[上游主机代码](https://github.com/c-ling/dsh-plugin-notify/blob/69cf298af2e241a9d83b3320214c413c0dc946cd/lib/index.js#L117)相似；这些通用短片段尚不足以单独认定实质模块复制。

ltao0829 的[检测模块](https://github.com/ltao0829/dsh-task-notify/blob/6735fd29909edc9e2f0531a52d671b2d9e607bcf/src/detect.ts)采用客户端快照差分，与本地主机端事件状态机不同。[通知模块](https://github.com/ltao0829/dsh-task-notify/blob/6735fd29909edc9e2f0531a52d671b2d9e607bcf/src/client/notify.ts#L203)中的 Notification 权限与首次手势处理，与本地 `task-radar/lib/client.js:163–183`、`:561–580` 有概念对应，未确认完整模块移植。README 将结束原因与运行中提问提醒归于该项目，但这些本地实现与 Pasumao 主干直接对应，后续来源说明应修正。

内部共享模块另有明确来源：`task-radar/lib/state-dir.js` 与工作区 `shared/state-dir.js` 逐字节一致，并由 `tools/sync-shared-code.mjs:44–56` 登记同步。它与上述三个社区项目的来源应分别记录。

## 图标：外观可见，创作来源尚待核实

`task-radar/assets/icon.png` 是 256×256 RGBA 雷达图，4756 字节，SHA-256 为 `ca4f8ff736445109ae25e347b9b4f7199009d1d91426771a5448788e79e3be9e`，未发现 PNG 来源元数据。它与 [Pasumao 的 assets/dsh.png](https://github.com/Pasumao/dsh-plugin-notify/blob/a802f00f4f9cc59893ec1df2218faf91552d8386/assets/dsh.png) 字节不同；上游是鲸鱼图标，本地是雷达图，当前证据不支持复制该图标，也不足以证明本地图标原创。

`task-radar/icon.svg:1–9` 使用圆形、路径与简单雷达几何。它与 PNG 配色接近，构图存在差异，尚未证明 PNG 是该 SVG 的导出物。审计未发现两图的作者、素材来源链接、生成脚本或单独许可记录。发布前应补齐创作记录与使用依据，或重新制作并记录来源。

## 打包与文档偏差

`task-radar/package.json:15–21` 的 files 白名单包含 lib、补丁、README、locale 和 icon.svg，遗漏 assets。`task-radar/lib/index.js:80–82` 默认读取 assets/icon.png，`:123` 在文件缺失时改用空图标，因此打包部署会丢失默认 Toast 图标；这是图标缺项，不是入口加载失败。SVG 已由清单第 13、20、22 行正确导出和包含。本结论来自白名单与引用的静态核对，未运行打包命令。

README 第 8、11、36 行及补丁注释第 4–6 行宣传 Webhook、HMAC、密文旁路、分事件音效与音量。当前 `task-radar/lib/config.js:27–53` 仅定义 Windows Toast、浏览器系统通知及事件等配置；`task-radar/lib/index.js:314–316` 仅记录 journal 并发送 Toast，浏览器端通过轮询发送 Notification。当前代码未实现上述 Webhook、签名、密文或音效能力。

此外，`task-radar/lib/index.js:482–487` 的测试入口仅发送主机 Toast，既不写 journal，也不发送浏览器通知；`task-radar/lib/client.js:440–444` 只调用该入口。README 所称“一次验证 Toast + 全部 Webhook”与当前实现不符。发布说明应以当前双通道真实能力为准。

## 后续可分发处理

若未来扩大收录范围，允许第三方改编插件进入仓库，可按以下条件处理：

1. 明确 task-radar 是包含 Pasumao 通知引擎改编的作品，标注模块与固定上游链接；保留 Pasumao 完整 MIT 许可和版权声明。仅保留 README 链接与 package.json 的 MIT 字段不足以替代原文。本地插件目录当前未发现 LICENSE、NOTICE 或 COPYING。
2. 自己新增且权利清晰的代码可采用 MIT；仓库的 MIT 声明应说明第三方保留声明与例外，避免把整个插件表述成纯原创。
3. 对 c-ling 的相似片段继续核对采用记录；如确认复制受保护代码，保留 chenchao 的 MIT 声明。如后续采用 ltao0829 的受保护代码，应保留 BSD-3-Clause 全文，源码保留版权、条件与免责条款，二进制分发在随附材料中重现，并遵守不借作者或贡献者名义背书的条款。
4. 核实或替换两张图标，补齐 assets 打包，修正文档宣传，再核对实际分发文件与第三方声明是否同时随包提供。

本批继续暂缓该插件，避免将许可兼容误记为来源已经符合纯自开发筛选条件。

## 本批范围备注

codex-quota 与 session-title-first-round 已退役，不在本批活动插件收录范围。本次未对其开展新的实现或素材溯源审计。
