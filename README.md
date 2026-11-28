# DSH 自开发插件

[English](README.en.md)

面向 DeepSeek Harness 的八款插件。工作区开发的功能与改编模块一并开源；涉及上游代码和配色的部分保留原署名及 MIT 许可，不宣称全仓零第三方代码。

| 插件 | 版本 | 功能 | 来源记录 |
|---|---|---|---|
| [archived-sessions](plugins/archived-sessions/README.md) | 0.8.0 | 归档筛选、清理预检、清单导出与可选回收站 | 工作区实现 |
| [session-meter](plugins/session-meter/README.md) | 0.5.1 | 会话费用、CSV/JSON、逐请求费用、本地日账本与可选账户余额 | 工作区实现；运行时外部价格数据 |
| [filekit](plugins/filekit/README.md) | 0.4.0 | CSV/TSV、DOCX、XLSX、PPTX、PDF 文本读取、大纲与全文检索 | [DeepSeek 兼容模块](plugins/filekit/THIRD_PARTY_NOTICES.md) |
| [github](plugins/github/README.md) | 0.3.0 | GitHub 分页读取、CI 日志、创建和合并 PR、更新 Issue 与提交评审 | [DeepSeek 兼容模块、新绘分支图标](plugins/github/THIRD_PARTY_NOTICES.md) |
| [ops-lite](plugins/ops-lite/README.md) | 0.3.0 | 有界多文件读取、字面量定位与目录树 | [DeepSeek 与 dsh-ops 改编部分](plugins/ops-lite/THIRD_PARTY_NOTICES.md) |
| [next-say](plugins/next-say/README.md) | 0.4.0 | 下一句预测、本地补全、方向键历史召回与每日调用预算 | [dsh-prompt-predict 辅助逻辑](plugins/next-say/THIRD_PARTY_NOTICES.md) |
| [task-radar](plugins/task-radar/README.md) | 0.4.0 | 页内通知、Windows Toast、静音时段与通用 webhook | [Pasumao 通知引擎改编、保留社区署名](plugins/task-radar/THIRD_PARTY_NOTICES.md) |
| [mcp-on-demand](plugins/mcp-on-demand/README.md) | 0.4.0 | MCP 按需挂载、目录搜索、探测与健康检查 | 工作区实现 |

逐包判断、复用范围、素材处理与来源记录见[来源审计](docs/source-audit.md)。task-radar 的社区改编和素材来源见[审计与整改记录](docs/task-radar-audit.md)。本轮改动见[发布检查记录](RELEASE-CHECK.md)，设置交互约定见[设置页 UX](docs/settings-ux-pattern.md)。

## 安装

需要 Node.js 22 或以上和 DeepSeek Harness。task-radar 需要 DSH 0.2.2-rc.3 或更新的兼容 0.2.x 版本。各包的宿主版本要求见其清单与说明。升级或重载前先检查正在运行的会话，安排好操作时机。

### 用 CLI 安装

下载或克隆本仓库后，在仓库根目录运行以下命令。将 `/path/to/profile` 换成现有的 DSH profile 目录，或直接指定它的 `package.json`。Windows 路径同样可以用引号括起来。

```sh
npm run install-plugins -- --list
npm run install-plugins -- --profile "/path/to/profile" --plugins filekit,next-say --dry-run
npm run install-plugins -- --profile "/path/to/profile" --plugins filekit,next-say
npm run install-plugins -- --profile "/path/to/profile" --all
npm run install-plugins -- --profile "/path/to/profile" --uninstall filekit,next-say
```

也可以直接运行 `npm run install-plugins`，按提示填写路径，输入编号勾选或取消插件，再按 Enter 确认。安装默认写入指向本地源码的绝对 `link:` 路径，也可以显式传入 `--link`。使用链接期间，请将仓库留在原位置。

每次写入前，CLI 会在 profile 旁保存 `package.json.bak.<时间戳>` 并打印路径。把实际备份路径传给 `npm run install-plugins -- --rollback "/path/to/profile/package.json.bak.<时间戳>"` 就能恢复当时的完整配置。预览和重复执行已生效的操作都不会生成备份。

写入配置前先关闭宿主。安装、卸载或回滚后，在 profile 目录用 DSH 配套包管理器同步依赖，再重启宿主、刷新页面。

### 手动安装

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

task-radar 的安装版集成测试也可选。将 `DSH_INSTALL_DIR` 指向已安装的 `@deepseek-ai/dsh` 包目录即可运行。

next-say 的词典和客户端、filekit 的 OOXML 测试样例、task-radar 的 SVG/PNG 图标均可用仓库里的 Node.js 工具重建。CI 会检查生成物与源码是否一致。

GitHub Actions 覆盖 Windows/Linux 与 Node.js 22/24。远端运行结果见 [Actions](https://github.com/mindydora8023-prog/dsh-first-party-plugins/actions)。

## 发布包

推送 `v*` tag 后，GitHub Actions 会跑完同一套测试矩阵，再发布八个插件的 `.tgz` 包、`SHA256SUMS.txt` 和 `manifest.json`。清单包含每个插件的版本、文件名、大小和 SHA-256。

```sh
node tools/pack-release.mjs
node tools/pack-release.mjs --check
```

第一条命令把发布文件写入 `dist/releases/`，第二条命令重新打包并核对本地发布文件。

## 使用行为

归档插件默认开启超过 5 天的归档清理，安装后应在设置页核对。GitHub 写工具会操作真实账户；next-say 预测使用辅助模型调用，会产生实际费用。具体开关与数据目录见各插件说明。

仓库不分发宿主解包树、真实会话、个人账号配置、凭据、附件、日志或外部价格快照。运行时文件应存放到用户状态目录或显式配置的数据目录。

## 许可证

本地贡献使用 [MIT](LICENSE)，版权行为 `dsh-plugins contributors`。各包的 THIRD_PARTY_NOTICES.md 和 licenses 目录保留适用上游的完整许可及署名；上游部分不以本仓库贡献者替换原权利人。
