# 发布检查记录

日期：2026-11-12。仓库：<https://github.com/mindydora8023-prog/dsh-first-party-plugins>。

## 0.3.1：task-radar 原生脚本修复

本机同步验证发现 0.1.1 的 JavaScript 引号转义没有形成合法的 PowerShell XML 字符串。task-radar 因此发布为 0.1.2：使用原始脚本与 PowerShell 单引号 XML 拼接、SecurityElement 转义，开启遇错终止；radar 只读接口增加实际加载版本字段。新增真实 Windows PowerShell 解析器回归测试，并用原先错误引号作为反例；此测试不显示通知，非 Windows 环境明确跳过。

本地原生执行验证使用已保存配置，严格脚本退出码为 0，CLIXML 无 Error 流（初始化 Progress 流另行区分），同时完成一次真实发送。用户配置保持字节一致。此结论表示系统 API 执行成功，不等同于确认用户屏幕可见横幅。既有用户配置与 profile 链接无需迁移。

## 历史：0.3.0：加入 task-radar 0.1.1

仓库现收录九款插件。task-radar 按社区改编作品分发，保留 Pasumao 和 chenchao 两份完整 MIT，明确 ltao 为尚未确认代码复制的功能参考，详见[来源与整改记录](docs/task-radar-audit.md)。

本次完成：

- 以新编写的几何源稿同时生成 SVG/PNG，删除来源未核实旧素材；源码、图标和 --check 随包提供。
- files 白名单补齐 assets、生成器、主许可证和两份上游许可；根检查器新增 assets 覆盖检查。
- 清理未实现的 Webhook/HMAC/自定义音效宣传，明确测试按钮仅提交 Windows 通道请求，submitted 不等于已显示。
- 添加通知发送器依赖注入，替换会发送真实 Toast 的旧测试；默认 PowerShell 子进程限制为 10 秒，并记录异常退出。

验证结果：task-radar 37 条离线测试全部通过，覆盖事件、冷却/开关、journal、浏览器权限/去重/点击/卸载、EncodedCommand、环境过滤、默认图标和失败日志。所有进程及浏览器通知均为替身，没有发送真实系统通知。

配置 Python 和兼容宿主检出后的全仓验证为 **550 条通过，0 失败、0 跳过**。主题另外通过入口语法检查；图标、词典/客户端和 OOXML 生成检查通过。公开 CI 未提供宿主检出时，仍有上批保留的 16 条真实宿主契约用例明确跳过。

实际构建 dsh-plugin-task-radar-0.1.1.tgz：16 个文件，包含 PNG/SVG、生成器、bundle、来源声明及两份上游 MIT。解包后图标生成 --check、入口语法和注入发送器 smoke 均通过；发送器实际解析打包后的默认 PNG 并携带 10 秒超时参数，未启动 PowerShell。打包后的运行代码与图标已与发布源码逐字节对比。

GitHub Actions 在四组 Windows/Linux、Node.js 22/24 环境执行测试与生成检查。首次运行暴露 next-say 既有构建探针会临时移走 ghost.js，导致并行 watchdog 导入竞态；已将探针改为操作独立临时副本，不改功能代码，也不通过跳过测试规避失败。最终状态以 Actions 页面为准。系统通知中心真实显示和实际浏览器权限/后台调度是手动验证边界，自动测试不冒充该验证。

活动安装源码及用户配置未修改。下文保留 0.2.0 的历史记录。

## 历史：0.2.0 范围

在首批 archived-sessions、session-meter 的基础上，新增 filekit、github、gmail、ops-lite、next-say、dsh-plugin-sauce-theme，共八款。此版本号表示仓库发布整理版本，各插件清单版本另行保留。

完整来源判断见 [docs/source-audit.md](docs/source-audit.md)。适用的 DeepSeek、T-Auto、ferrisching 与 Catppuccin MIT 原文随对应插件携带；主许可证只覆盖本地贡献，不替换上游版权。

task-radar 暂缓的具体证据与剩余工作见[专项记录](docs/task-radar-audit.md)。第三方 purge 插件与历史退役插件未收录。

## 整理内容

- 活动安装源码未修改，所有发布改动位于独立仓库。
- 新增插件均附 MIT 主许可证、THIRD_PARTY_NOTICES.md 和适用的 licenses 文本。
- GitHub 发布图标换为本次新写的分支节点 SVG，未带原 Invertocat 轮廓。
- filekit 的 DOCX/XLSX 样例重建为自编最简 OOXML，移除第三方默认模板、主题、缩略图和文档元数据；提供确定性生成器。
- ops-lite 修复 files 白名单漏收 bundle 配置的问题。
- Gmail 默认 npm test 改为离线测试，未收录真实邮件操作脚本或本机 Python CLI 启动器。
- 测试移除个人机器路径；GitHub 测试以跨平台 CLI 替身取代真实账号发现；共享源副本随仓库提供。
- next-say 增加词典源与客户端生成物的独立逐字节检查，并保留模板和生成器。
- 对齐主题和其他插件的实际功能描述，移除原工作区账号、路径和历史会话现状。
- 每个插件测试有外层 60 秒硬超时；主题仅验证入口语法，不声称具备行为测试。

## 本地验证

配置兼容宿主检出与 Python 后：

| 套件 | 测试数 | 通过 | 跳过 |
|---|---:|---:|---:|
| archived-sessions | 49 | 49 | 0 |
| filekit | 82 | 82 | 0 |
| github | 69 | 69 | 0 |
| gmail | 31 | 31 | 0 |
| next-say | 127 | 127 | 0 |
| ops-lite | 75 | 75 | 0 |
| session-meter | 80 | 80 | 0 |
| 合计 | 513 | 513 | 0 |

所有用例 0 失败、0 取消。主题两入口通过语法检查。next-say 词典与客户端同步检查、filekit 三个 Office 样例 --check 均通过。filekit 的独立 Office 库重开验证与 PDF 再生字节比较通过。

没有宿主检出的公开环境，filekit 的 9 条、gmail 的 4 条和 ops-lite 的 3 条真实宿主比较用例会明确跳过；其余用例照常执行。Python 由 CI 显式安装。不要把这些环境条件下的跳过计作通过。

## 实际打包检查

执行 npm pack --dry-run --ignore-scripts，八包均包含 README、LICENSE 和 bundle 配置；六个新增包均包含 THIRD_PARTY_NOTICES.md 与适用上游许可。

| 包 | 文件数 | 上游许可证文件数 |
|---|---:|---:|
| archived-sessions | 12 | 0 |
| session-meter | 11 | 0 |
| filekit | 22 | 1 |
| github | 16 | 1 |
| gmail | 19 | 1 |
| ops-lite | 21 | 2 |
| next-say | 16 | 1 |
| sauce-theme | 11 | 1 |

源码仓库另外包含开发测试与生成器。npm 运行包未包含测试样例，这与源码交付的文件范围不同。

## 远端验证

GitHub Actions 配置覆盖 Windows/Linux 与 Node.js 22/24，显式安装 Python、运行发行检查、测试、词典/客户端同步和样例再生检查。最终提交状态以 [Actions 页面](https://github.com/mindydora8023-prog/dsh-first-party-plugins/actions) 为准。
