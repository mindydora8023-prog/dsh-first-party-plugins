# DSH 自开发插件

面向 DeepSeek Harness 的八款插件。工作区开发的功能与改编模块一并开源；涉及上游代码和配色的部分保留原署名及 MIT 许可，不宣称全仓零第三方代码。

| 插件 | 版本 | 功能 | 来源记录 |
|---|---|---|---|
| [archived-sessions](plugins/archived-sessions/README.md) | 0.5.1 | 归档恢复、删除预检、孤儿子代理与超期清理 | 工作区实现 |
| [session-meter](plugins/session-meter/README.md) | 0.3.0 | 会话费用、峰谷时段、分模型用量 | 工作区实现；运行时外部价格数据 |
| [filekit](plugins/filekit/README.md) | 0.1.0 | CSV/TSV、DOCX、XLSX、PDF 有界读取 | [DeepSeek 兼容模块](plugins/filekit/THIRD_PARTY_NOTICES.md) |
| [github](plugins/github/README.md) | 0.1.0 | GitHub 查询与 Issue/评论写入工具 | [DeepSeek 兼容模块、新绘分支图标](plugins/github/THIRD_PARTY_NOTICES.md) |
| [gmail](plugins/gmail/README.md) | 0.1.0 | IMAP/SMTP 邮件读取与操作 | [DeepSeek 兼容模块](plugins/gmail/THIRD_PARTY_NOTICES.md) |
| [ops-lite](plugins/ops-lite/README.md) | 0.1.0 | 有界多文件文本读取 | [DeepSeek 与 dsh-ops 改编部分](plugins/ops-lite/THIRD_PARTY_NOTICES.md) |
| [next-say](plugins/next-say/README.md) | 0.1.0 | 下一句预测、历史补全、Tab 填草稿 | [dsh-prompt-predict 辅助逻辑](plugins/next-say/THIRD_PARTY_NOTICES.md) |
| [sauce-theme](plugins/dsh-plugin-sauce-theme/README.md) | 0.7.1 | 浅色对话主题、等宽字体范围 | [Catppuccin Latte 配色](plugins/dsh-plugin-sauce-theme/THIRD_PARTY_NOTICES.md) |

逐包判断、复用范围、素材处理与未解决的来源记录见[来源审计](docs/source-audit.md)。task-radar 的通知引擎主体为社区改编，本批暂缓，见[单独记录](docs/task-radar-audit.md)。历史退役插件未纳入当前发行范围。

## 安装

需要 Node.js 22 或以上和 DeepSeek Harness。发布源码来自 DSH 0.2.2-rc.1 的本地环境；其他宿主版本需验证服务与客户端接口。

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

在 profile 目录用 DSH 配套包管理器安装依赖，再重启宿主、刷新页面。各插件可以独立选择。包名以各插件清单为准，主题包名为 `dsh-plugin-sauce-theme`。

没有第三方 npm 运行时依赖；DSH 宿主服务与浏览器模块由宿主提供。`private: true` 用于防止意外 npm 发布，不影响 MIT 源码许可。

## 验证

```sh
npm test
npm run check
```

默认测试不连接真实 GitHub/Gmail，不发送邮件，不读取个人会话。每个插件测试子进程设 60 秒硬超时；没有行为测试的主题只验证入口语法，未伪装成行为测试覆盖。

工具插件保留可选真实宿主比较测试：未设置 `DSH_HOST_CHECKOUT` 且没有兼容宿主检出时，相关用例明确显示跳过。可将变量设为含 node_modules/@deepseek-ai 的兼容检出根目录；宿主代码不随本仓库分发。纯函数、协议、替身与共享一致性用例仍会实际执行。

next-say 的客户端模板与词典生成工具随源码提供，需要 Python 3。其词典与客户端同步检查在 CI 单独执行；filekit 的最简 OOXML 测试样例由随包 Node.js 生成器构建。

GitHub Actions 覆盖 Windows/Linux 与 Node.js 22/24。远端运行结果见 [Actions](https://github.com/mindydora8023-prog/dsh-first-party-plugins/actions)。

## 使用行为

归档插件默认开启超过 5 天的归档清理，安装后应在设置页核对。GitHub 与 Gmail 写工具会操作真实账户；next-say 预测使用辅助模型调用，会产生实际费用。具体开关与数据目录见各插件说明。

仓库不分发宿主解包树、真实会话、个人账号配置、凭据、附件、日志或外部价格快照。运行时文件应存放到用户状态目录或显式配置的数据目录。

## 许可证

本地贡献使用 [MIT](LICENSE)，版权行为 `dsh-plugins contributors`。各包的 THIRD_PARTY_NOTICES.md 和 licenses 目录保留适用上游的完整许可及署名；上游部分不以本仓库贡献者替换原权利人。
