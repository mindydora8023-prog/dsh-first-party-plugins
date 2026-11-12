# 有界多文件读取

为 DeepSeek Harness 增加 `ops_read_files`：一次读取多个 UTF-8 文本文件，每个文件有独立的行号窗口、返回预算与续读位置。版本 0.1.0。

- 文件层返回 complete/nextOffset，批量层返回 pending/nextIndex。
- 输出预算按转义后字节计算，截断给出恢复位置。
- 失败记录说明 effectState、retry 与下一步动作。
- 仅在路径与范围信息可验证时使用紧凑显示，否则保留完整诊断格式。

插件主体在本工作区开发，部分完整性和错误策略逻辑实际改编自 dsh-ops，工具参数助手来自 DSH 宿主兼容移植。两项均为 MIT，具体文件映射与许可见[来源说明](THIRD_PARTY_NOTICES.md)。这不是零第三方代码声明。

## 安装与使用

参见[仓库安装说明](../../README.md)。包名 `dsh-plugin-ops-lite`，配置模板在本包 bundle 文件中。发布副本已补齐原白名单遗漏的 bundle 配置文件。

示例工具参数：

```json
{"files":[{"path":"src/a.js","offset":1,"limit":100},{"path":"src/b.js","offset":20,"limit":50}]}
```

文档格式由另一个 filekit 插件处理。该插件使用宿主文件服务，读取权限随宿主设置生效；不自带 shell。

## 开发

```sh
npm test
npm run check
```

默认测试使用本地替身；真实 Cordis 测试在没有宿主检出时明确跳过。可将 `DSH_HOST_CHECKOUT` 设为包含 node_modules 的兼容宿主检出目录，启用可选集成检查；仓库不包含宿主解包产物。

[MIT](LICENSE) · [第三方声明](THIRD_PARTY_NOTICES.md)。
