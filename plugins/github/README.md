# GitHub 原生工具

为 DeepSeek Harness 提供 16 个 GitHub 工具，覆盖仓库、文件、提交、分支、Issue、PR、Actions 查询，以及创建 Issue 与发表评论。版本 0.1.0。

使用 Node.js 内置 fetch 和子进程，无第三方 npm 运行时依赖。主体在本工作区开发，工具参数兼容模块带有 DeepSeek MIT 来源，见[来源说明](THIRD_PARTY_NOTICES.md)。

## 安装与配置

参见[仓库安装说明](../../README.md)。包名为 `dsh-plugin-github`；配置项见本包的 bundle 配置模板。

凭据依次支持插件配置、GITHUB_TOKEN/GH_TOKEN 环境变量、凭据文件、Git Credential Manager 与 gh CLI。读取凭据仅发生在实际调用插件工具时；本包不分发任何账号凭据。

建议使用环境变量或源码目录之外的凭据文件。`useGitCredential` 与 `useGhCli` 可分别关闭。关闭 `allowWrite` 后不注册写工具；默认开启时，创建 Issue 与评论会真实写入 GitHub。

匿名模式可读公开仓库，受 GitHub 匿名配额限制；代码搜索及写操作需要登录。可通过 `apiBaseUrl` 使用 GitHub Enterprise。代理可来自显式配置、环境变量和 Windows 系统代理。

## 开发

```sh
npm test
npm run check
```

默认测试使用本地 HTTP/CLI 替身，不调用真实 GitHub API；真实账号发现与在线 smoke 脚本未纳入本发布包。命令行测试在 Windows 与 POSIX 使用各自的可执行替身。

原工作区的 GitHub 品牌图形已在发布副本中替换为新写的分支节点 SVG；当前安装实例不受影响。

[MIT](LICENSE) · [第三方声明](THIRD_PARTY_NOTICES.md)。
