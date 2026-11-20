# DSH 自开发插件

面向 DeepSeek Harness 的八款插件。工作区开发的功能与改编模块一并开源；涉及上游代码和配色的部分保留原署名及 MIT 许可，不宣称全仓零第三方代码。

| 插件 | 版本 | 功能 | 来源记录 |
|---|---|---|---|
| [archived-sessions](plugins/archived-sessions/README.md) | 0.6.0 | 归档恢复、排序分组、删除预检与超期清理预览 | 工作区实现 |
| [session-meter](plugins/session-meter/README.md) | 0.3.52 | 会话费用、峰谷时段、缓存节省、上下文占用 | 工作区实现；运行时外部价格数据 |
| [filekit](plugins/filekit/README.md) | 0.2.0 | CSV/TSV、DOCX、XLSX、PPTX 转 Markdown，PDF 文本页 | [DeepSeek 兼容模块](plugins/filekit/THIRD_PARTY_NOTICES.md) |
| [github](plugins/github/README.md) | 0.2.0 | GitHub 分页读取、提交 diff、PR 行评论、CI 失败日志，以及 Issue/评论写入 | [DeepSeek 兼容模块、新绘分支图标](plugins/github/THIRD_PARTY_NOTICES.md) |
| [ops-lite](plugins/ops-lite/README.md) | 0.2.0 | 一次读取文件、目录或 glob，并可按字面量定位 | [DeepSeek 与 dsh-ops 改编部分](plugins/ops-lite/THIRD_PARTY_NOTICES.md) |
| [next-say](plugins/next-say/README.md) | 0.2.3 | 下一句预测、前缀跟随、逐词采纳、历史补全 | [dsh-prompt-predict 辅助逻辑](plugins/next-say/THIRD_PARTY_NOTICES.md) |
| [task-radar](plugins/task-radar/README.md) | 0.3.0 | 页内可点卡片、到点消失的 Windows Toast、静音时段 | [Pasumao 通知引擎改编、保留社区署名](plugins/task-radar/THIRD_PARTY_NOTICES.md) |
| [mcp-on-demand](plugins/mcp-on-demand/README.md) | 0.3.0 | 按需挂载 MCP：目录搜索、探测后断开，用到才挂载 | 工作区实现 |

逐包判断、复用范围、素材处理与来源记录见[来源审计](docs/source-audit.md)。task-radar 已补齐社区改编声明、替换来源不明图标并完成发布整理，见[审计与整改记录](docs/task-radar-audit.md)。历史退役插件未纳入当前发行范围。

## 安装

需要 Node.js 22 或以上和 DeepSeek Harness。task-radar 0.3.0 需要 DSH 0.2.2-rc.3 或更新的兼容 0.2.x 版本；其他插件的原始发布环境为 DSH 0.2.2-rc.1。各包的宿主版本要求以其清单与说明为准。升级或重载前先检查正在运行的会话，安排好操作时机。

下载或克隆本仓库，选取需要的插件。在 DSH 插件管理中使用本地包安装入口；或者关闭宿主后，合并目标 profile 的配置。以下仅以两个插件示例，请替换绝对路径并保留原配置：

```json
{
  "dependencies": {
    "dsh-plugin-filekit": "link:/ABSOLUTE/PATH/dsh-first-party-plugins/plugins/filekit",
    "dsh-plugin-next-say": "link:/ABSOLUTE/PATH/dsh-first-party-plugins/plugins/next-say"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-plugin-filekit", "dsh-plugin-next-say"]
    }
  }
}
```

在 profile 目录用 DSH 配套包管理器安装依赖，再重启宿主、刷新页面。各插件可以独立选择。包名以各插件清单为准。

没有第三方 npm 运行时依赖；DSH 宿主服务与浏览器模块由宿主提供。`private: true` 用于防止意外 npm 发布，不影响 MIT 源码许可。

## 验证

```sh
npm test
npm run check
```

默认测试不连接真实 GitHub，不读取个人会话。每个插件测试子进程设 60 秒硬超时；没有行为测试的主题只验证入口语法，未伪装成行为测试覆盖。

工具插件保留可选真实宿主比较测试：未设置 `DSH_HOST_CHECKOUT` 且没有兼容宿主检出时，相关用例明确显示跳过。可将变量设为含 node_modules/@deepseek-ai 的兼容检出根目录；宿主代码不随本仓库分发。纯函数、协议、替身与共享一致性用例仍会实际执行。

next-say 的客户端模板与词典生成工具随源码提供，需要 Python 3。其词典与客户端同步检查在 CI 单独执行；filekit 的最简 OOXML 测试样例、task-radar 的 SVG/PNG 图标由随包 Node.js 生成器构建，CI 验证生成物一致性。

GitHub Actions 覆盖 Windows/Linux 与 Node.js 22/24。远端运行结果见 [Actions](https://github.com/mindydora8023-prog/dsh-first-party-plugins/actions)。

## 使用行为

归档插件默认开启超过 5 天的归档清理，安装后应在设置页核对。GitHub 写工具会操作真实账户；next-say 预测使用辅助模型调用，会产生实际费用。具体开关与数据目录见各插件说明。

仓库不分发宿主解包树、真实会话、个人账号配置、凭据、附件、日志或外部价格快照。运行时文件应存放到用户状态目录或显式配置的数据目录。

## 许可证

本地贡献使用 [MIT](LICENSE)，版权行为 `dsh-plugins contributors`。各包的 THIRD_PARTY_NOTICES.md 和 licenses 目录保留适用上游的完整许可及署名；上游部分不以本仓库贡献者替换原权利人。
