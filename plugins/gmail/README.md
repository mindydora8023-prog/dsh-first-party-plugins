# Gmail 原生工具

通过 IMAP/SMTP 为 DeepSeek Harness 提供搜索、读取、线程、发信、标签、归档、标星和新邮件游标工具，共 9 个。版本 0.1.0，仅使用 Node.js 内置模块。

本发行物是 DSH 插件，不包含工作区另外维护的 Python CLI 和 Windows 启动器。

## 安装与凭据

参见[仓库安装说明](../../README.md)，包名为 `dsh-plugin-gmail`。使用 Google 应用专用密码，默认 IMAP 为 imap.gmail.com:993、SMTP 为 smtp.gmail.com:465。

可通过 `GMAIL_ADDRESS`、`GMAIL_APP_PASSWORD` 设置凭据，或在插件配置中指定源码目录以外的 `credentialsPath`。凭据文件结构如下，示例值必须替换：

```json
{"address":"someone@example.com","app_password":"REPLACE_ME"}
```

默认候选还包括用户插件状态目录、profile 和宿主目录；源码目录是兼容旧安装的最后候选。新安装应把真实凭据留在源码之外。Windows 用户状态目录通常位于 `%LOCALAPPDATA%/dsh-plugins/gmail/`，可用 `DSH_PLUGIN_STATE_DIR` 覆盖。

`allowSend: false` 可隐藏发信工具；`allowWrite: false` 可关闭已读、标星、标签和归档修改。读取工具不自动标为已读。实际调用发送和修改工具会操作真实邮箱。

附件目录默认在插件下的 attachments；可设置 `attachmentsDir` 放到用户数据目录。运行时诊断与新邮件游标默认放到状态目录。不要提交真实附件、凭据或游标。

## 开发

```sh
npm test
npm run check
```

默认测试只使用替身，不连接 Gmail、不发送邮件；原工作区的在线 smoke、邮箱检查及清理脚本未收录。

[MIT](LICENSE) · [来源与第三方声明](THIRD_PARTY_NOTICES.md)。
