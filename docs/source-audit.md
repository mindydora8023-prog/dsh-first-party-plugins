# 插件代码与素材来源核对

核对日期：2026-11-12。范围为本机活动自开发插件的本次发布副本。采用源码阅读、上游固定版本比较、许可原文与二进制容器检查；未把“参考同类功能”直接认定为复制，也未把“没有版权注释”当作原创证明。

## 本批决定

| 插件 | 来源判断 | 本次处理 |
|---|---|---|
| filekit | 文档解析器为本地实现，工具定义及一份契约测试明确记录宿主移植；旧 Office fixtures 实际含库模板字节 | 加 DeepSeek MIT；用自编最简 OOXML 生成器替换含模板样例；收录 |
| github | REST 封装和凭据/代理工具为工作区实现，工具助手为宿主兼容移植；旧图标是 GitHub 品牌轮廓 | 加 DeepSeek MIT；换本次新写的分支节点 SVG；收录 |
| gmail | 本地 IMAP/SMTP、MIME 与工具接线，工具助手为宿主兼容移植 | 加 DeepSeek MIT；只发布插件，排除独立 Python CLI 与本机启动器；收录 |
| ops-lite | 自开发读取集成，完整性和失败策略有明确 dsh-ops 改编标记，工具助手含宿主移植 | 保留 DeepSeek、T-Auto MIT 与模块映射；修正 bundle 打包缺项；收录 |
| next-say | 宿主集成、补全与输入层为本地开发；预测辅助模块与 dsh-prompt-predict 存在实质对应 | 将 predict.js 按上游改编处理，保留 ferrisching MIT；补生成器完整性检查；收录 |
| sauce-theme | 自开发 DSH 样式接线，实际使用 Catppuccin Latte 配色 | 保留 Catppuccin MIT；对齐单浅色主题描述；收录 |
| task-radar | 通知发动机主干与 Pasumao 社区插件成组对应；图标创作记录未核实，宣传与当前实现有偏差 | 本批暂缓，见[专项记录](task-radar-audit.md) |

archived-sessions、session-meter 为首批已收录插件，继续保留。第三方 dsh-purge-community 不在本次发布范围。codex-quota 与 session-title-first-round 已退役，本次只记录状态，未新增溯源结论。

收录标准是本工作区开发的功能插件、可明确限定的改编范围、已核实的分发许可与可审阅交付；不是“全仓所有行必须独立原创”。通知插件暂缓还涉及主体来源和未完成整理，不能据此推断其他采用 MIT 辅助模块的插件不应发布。

## DeepSeek 兼容模块

四个工具插件 `lib/define.js` 与工作区共享源相同。共享源自述 compiler/validator 是宿主行为的 faithful ports。filekit 的 `test/contract.test.mjs` 也注明 compiler/checker 移植。按已有说明与实现对应保守披露，而不以仅行为一致推断复制。

本次读取已安装 `@deepseek-ai/dsh-tools` 0.2.2-rc.1 的清单与 LICENSE，确认 MIT，`Copyright (c) 2026 DeepSeek`，上游目录为 [packages/core/tools](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/core/tools)。每个涉及的独立包都附完整许可；共享源目录也附一份。最初采用时的历史提交未记录，本次版本号是核对基准。

## dsh-ops 改编范围

ops-lite 的 compact.js 注明改编 ranges.ts/file-batching.md；outcome.js 注明改编 outcome.ts/errors.ts。核对发现范围验证、字段排列、错误策略等组合对应，超过单纯理念借鉴。

可复核基准：[186a8fe6ca37d9f91a3cd9635c33e3a60e6ec664](https://github.com/T-Auto/dsh-ops/tree/186a8fe6ca37d9f91a3cd9635c33e3a60e6ec664)，[MIT 原文](https://github.com/T-Auto/dsh-ops/blob/186a8fe6ca37d9f91a3cd9635c33e3a60e6ec664/LICENSE)，版权为 T-Auto and the dsh-ops contributors。该 ref 是可复核对应版本，不代表恢复了最初拷贝的提交。

未包含上游 FastCtx、Niubash、Rust 工具及载荷，因此不把上游整个发行物的组合许可机械套到这两个 JS 改编部分。随包许可文件保留适用的完整 MIT 正文；上游 LICENSE 中其他发行物范围说明见固定链接。

## next-say 实际移植与新增

[固定基准 dsh-prompt-predict](https://github.com/ferrisching/dsh-prompt-predict/blob/ded6c292b4347a47825520ef54b5b20ca53e8bd7/lib/predict.mjs)与本地 predict.js 的提示词连续句段、0.6/2.5 预算系数、语言投票、默认 8/6000/1600 历史窗口、倒序裁剪与每条 +32 等细节对应。按整个预测辅助文件涉及上游改编处理，附 [ferrisching MIT](https://github.com/ferrisching/dsh-prompt-predict/blob/ded6c292b4347a47825520ef54b5b20ca53e8bd7/LICENSE)。

本地增加的请求路由、耐久日志回合识别、历史前缀匹配、ghost 输入层布局和设置集成分别记录；不把共享 API 和通用算法误当作者证明。有限比较其他同类项目未确认具体代码复用，不凭搜索候选添加未经证实的版权关系。

## 配色、图标与字体

主题八个色值与 [Catppuccin Latte 1.8.0](https://github.com/catppuccin/palette/blob/07d02aa110ef9eb7e7427afca5c73ba9cf7f8ebd/palette.json)一致，保留 [Catppuccin MIT](https://github.com/catppuccin/palette/blob/07d02aa110ef9eb7e7427afca5c73ba9cf7f8ebd/LICENSE)。OpenCode 的风格描述本身不证明复制其代码，未发现其代码或 logo 被直接带入。

原 github 图标有 Invertocat 长路径，并与背景及虚线圈组合。参考 [GitHub 品牌规则](https://brand.github.com/foundations/logo)后，发布副本以新写的分支节点 SVG 替代，并将 SVG 自身作为创作源稿。

其余图标是内联几何 SVG，没有链接或嵌入第三方图片。未查得完整早期绘制记录，文档只声明实际观察，不承诺已证明全部创作历史。主题只列系统字体回退名称，没有捆绑字体程序。

## 测试样例

原 DOCX 的样式、主题、缩略图等多个 part 与 python-docx 的默认模板逐字节相同；两个 XLSX 的主题与 openpyxl theme_xml 相同。这里的许可关注依据是实际模板字节，而不是“用库生成输出就自动继承库许可证”。

发布副本用随源码提供的 Node.js 最简 OOXML 生成器重建 DOCX、Sales/Meta 工作簿和日期工作簿，保留测试文字、数值、布尔和日期语义，去除默认模板、主题、缩略图与个人文档元数据。用独立 Office 库重开验证，且生成器有确定性 --check。原有库模板不随发布包分发。

PDF 由自有 Node/zlib 生成器复现，与 sample.pdf 逐字节一致；只引用标准 Helvetica 名称，不嵌入字体。CSV 为合成解析数据。

## 记录边界

这是针对当前文件和可获取上游版本的来源核对，不是全部历史创作过程的证明。filekit PDF 中的 CP1252/MacRoman 标准映射等早期收集出处未记录；本次未发现证据支持将其认定为某个特定库代码，不额外捏造 Apache/Unicode 归属。各包仍保留这些边界说明。

活动安装目录未被本次发布整理修改。独立发布目录的变动包括文档、许可证、图标、测试样例、可移植测试与生成检查；功能代码除来源注释外保持原有实现。
