# 发布检查记录

日期：2026-11-12。仓库：<https://github.com/mindydora8023-prog/dsh-first-party-plugins>。

## 0.2.0 范围

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
