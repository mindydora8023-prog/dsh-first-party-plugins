# 任务雷达

为 DeepSeek Harness 提供任务通知：Windows 原生 Toast 与浏览器系统通知两条通道，可分别开关。版本 0.1.2。

插件包含 Pasumao 通知引擎的改编与本工作区的配置、浏览器 journal、设置集成等开发。来源与适用 MIT 原文见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，不声明全包独立原创。

## 当前功能

| 事件 | 默认开关 | 触发 |
|---|---|---|
| turnStart | 关 | 智能体进入运行状态 |
| finished | 开 | 活跃回合正常结束 |
| aborted | 开 | 中止、中断或阻断后结束 |
| error | 开 | 错误或输出上限后结束 |
| waiting | 开 | 运行中调用 ask_user_question；或运行中的智能体被关闭 |

默认只提醒根会话，过滤子代理。通知正文带可解析的工作区和会话名称；相同事件与会话受冷却时间限制，默认 4 秒。

Windows 通道由宿主调用 PowerShell 5.1/WinRT，不要求浏览器页面保持前台；实际显示取决于操作系统通知设置。支持自定义 PNG 路径与 reminder 常驻选项。发送子进程有超时，不会无限等待。

浏览器通道需要通知权限和仍在运行的页面，以约 2.5 秒间隔轮询宿主内存 journal。点击浏览器通知会唤醒窗口，并尝试在应用中打开对应会话。Windows Toast 没有同等会话跳转接线。两个通道同时开启可能收到两条提醒。

目前只有上述两个通道。旧文档所提 Webhook、飞书/钉钉/企微推送、HMAC 加签、密文接口和自定义分事件音效未在本版本实现；系统自身可能播放通知提示音。

## 安装与设置

参见[仓库安装说明](https://github.com/mindydora8023-prog/dsh-first-party-plugins#安装)。包名为 `dsh-plugin-task-radar`。安装并重启宿主、刷新页面后，在设置中的“任务雷达”配置总开关、事件、通道、根会话过滤、冷却、摘要长度、标题前缀、图标及常驻选项。

修改设置后点保存。配置默认写入用户状态目录的 `dsh-plugins/task-radar/config.json`，可用 `DSH_PLUGIN_STATE_DIR` 或 `TASK_RADAR_CONFIG_FILE` 覆盖，不写入源码目录。

“测试通知”按钮使用已保存的配置，当前只提交 Windows Toast 测试请求；它不模拟完整任务，也不向浏览器 journal 注入事件。请求返回成功不代表操作系统已实际显示通知。浏览器通道应授予权限后，用一次任务事件核对。

## 运行数据

宿主内存最多保存 24 条通知 journal，包含标题、摘要、位置和会话标识；重启后消失，浏览器通过同源接口读取。插件不向第三方推送服务上传这些数据。真实通知可能展示任务摘要，请按需关闭通道或调整摘要长度。

## 开发与验证

```sh
npm test
npm run build
npm run check:icons
```

测试使用临时目录、宿主与浏览器替身、可替换的通知发送器，不发送真实系统通知，不访问真实账户或网络。Windows 另有真实 PowerShell 语法解析测试，仅解析脚本而不执行通知；其他平台明确跳过该用例。实际 Windows 通知中心与真实浏览器显示属于手动验证，不由替身测试冒充。

0.1.2 修复原生脚本把 JavaScript 的引号转义误用到 PowerShell XML 字符串的问题，改用 PowerShell 单引号拼接和 SecurityElement XML 转义，并开启遇错终止，使进程退出日志可以反映执行失败。

图标源稿与重建入口：

```sh
node tools/build-icons.mjs
node tools/build-icons.mjs --check
```

两种图标由同一几何定义生成，Node.js 标准库即可重建；运行包同时包含 SVG、PNG、生成器和完整许可证。修改生成物前先改源稿。

[MIT](LICENSE) · [来源声明](THIRD_PARTY_NOTICES.md)。
