# DSH 自开发插件

DeepSeek Harness 的两款自开发插件，采用 MIT 许可证发布。

| 插件 | 版本 | 功能 |
|---|---|---|
| [archived-sessions](plugins/archived-sessions/README.md) | 0.5.1 | 归档会话恢复、删除预检、隐藏子代理清理与超期清理 |
| [session-meter](plugins/session-meter/README.md) | 0.3.0 | 会话费用估算、DeepSeek 峰谷时段与分模型用量 |

## 环境与安装

- Node.js 22 或以上。
- 插件依赖 DeepSeek Harness 提供的宿主服务与浏览器模块。
- 当前发布源码来自 DSH 0.2.2-rc.1 的本地使用环境；其他版本请先验证接口兼容性。
- 没有第三方 npm 运行时依赖。

先下载或克隆本仓库。在 DSH 插件管理中使用可用的本地包安装入口；也可以在关闭宿主后，编辑目标 profile 的清单，合并以下配置。请将示例中的绝对路径替换成实际检出路径，并保留 profile 原有配置：

```json
{
  "dependencies": {
    "dsh-plugin-archived-sessions": "link:/ABSOLUTE/PATH/dsh-plugins/plugins/archived-sessions",
    "dsh-plugin-session-meter": "link:/ABSOLUTE/PATH/dsh-plugins/plugins/session-meter"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-plugin-archived-sessions",
        "dsh-plugin-session-meter"
      ]
    }
  }
}
```

在该 profile 的目录中使用 DSH 配套包管理器安装依赖，使包能从 profile 的 node_modules 解析。随后重启 DSH 并刷新页面。两款插件可分别安装。

清单保留 `private: true`，源码仍按 MIT 开源；此字段用于避免意外发布到 npm。

## 开发与验证

```sh
npm test
```

无需安装 npm 依赖。测试仅使用本地替身，不启动 DSH，不读取真实会话。测试入口为每个插件的子进程设置 60 秒硬超时。GitHub Actions 配置覆盖 Windows / Linux 与 Node.js 22 / 24；远端执行结果以 Actions 页面为准。

归档插件的中文提示词典由 Python 3 生成：

```sh
cd plugins/archived-sessions
python tools/build-reasons.py --check
```

运行时 JavaScript 保持 ASCII，中文界面词典使用转义或语言 JSON。

## 来源与数据

- 本批次只收录 `archived-sessions` 和 `session-meter`。
- 第三方插件、包含第三方移植标记的工具插件、明确参考社区实现的插件与主题暂未收录。
- DSH 宿主本体、宿主解包产物、真实会话、账号配置、凭据、日志和价格缓存均不随仓库分发。
- 两个插件中的状态目录助手来自同一工作区的自开发共享模块，已随各包携带。
- `session-meter` 运行时可请求 models.dev 价格目录及 open.er-api.com 汇率。这是外部数据服务调用；仓库不包含这些服务的数据快照。详情见插件说明。

## 许可证

[MIT](LICENSE)。版权声明使用 `dsh-plugins contributors`，贡献者可在贡献记录中维护署名。
