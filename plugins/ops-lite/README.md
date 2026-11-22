# 有界多文件读取

为 DeepSeek Harness 提供 `ops_read_files` 和 `ops_tree`。`ops_read_files` 一次读取多个 UTF-8 文本文件，`path` 可以是文件、目录或通配。`ops_tree` 列出目录结构，可设置深度和条目上限，并跳过依赖目录、版本控制目录和凭据路径。版本 0.3.0。

- 目录只取直接子文件里的文本；通配跳过 `node_modules`、`.git`、`dist`，并丢掉凭据路径。
- `literal` 从第一次精确命中打开窗口，`around` 是命中行之前的上下文，默认 20 行。
- 同一路径一次调用只读一次；最多两路同时读，超出字节预算的文件不会打开。
- 文件层返回 complete/nextOffset，批量层返回 pending/nextIndex。
- 输出预算按转义后字节计算，截断给出恢复位置。
- 失败记录说明 effectState、retry 与下一步动作。
- 仅在路径与范围信息可验证时使用紧凑显示，否则保留完整诊断格式。

插件主体在本工作区开发，部分完整性和错误策略逻辑实际改编自 dsh-ops，工具参数助手来自 DSH 宿主兼容移植。两项均为 MIT，具体文件映射与许可见[来源说明](THIRD_PARTY_NOTICES.md)。这不是零第三方代码声明。

## 安装与使用

参见[仓库安装说明](../../README.md)。包名 `dsh-plugin-ops-lite`，配置模板在本包 bundle 文件中。发布副本已补齐原白名单遗漏的 bundle 配置文件。

示例工具参数：

```json
{"files":[{"path":"src/**/*.js","limit":40},{"path":"lib/tools.js","literal":"function readOne","around":20}]}
```

文档格式由另一个 filekit 插件处理。该插件使用宿主文件服务，读取权限随宿主设置生效；不自带 shell。

## 开发

```sh
npm test
npm run check
```

默认测试使用本地替身；真实 Cordis 测试在没有宿主检出时明确跳过。可将 `DSH_HOST_CHECKOUT` 设为包含 node_modules 的兼容宿主检出目录，启用可选集成检查；仓库不包含宿主解包产物。

[MIT](LICENSE) · [第三方声明](THIRD_PARTY_NOTICES.md)。
