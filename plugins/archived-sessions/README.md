# 已归档会话管理

为 DeepSeek Harness 设置页提供归档会话恢复、删除预检、孤儿子代理清理与超期自动清理。版本 0.5.1，MIT 许可证。

## 功能

- 按标题、ID、目录搜索归档会话，支持中英文界面。
- 恢复归档会话，保留原侧栏位置。
- 删除前检查引用关系，列出将级联清理的隐藏子代理。
- 清理日志已消失的归档记录，以及父会话已消失的孤儿子代理。
- 后台按保留天数清理超期归档会话，可在设置页调整规则或手动执行。

## 删除与自动清理行为

永久删除会移除会话日志与相关元数据。删除前会校验真实路径、获取租约、隔离目录；元数据处理失败时尝试回滚。正在运行、有工作区成员引用或存在其他阻塞引用的会话会保留。

自动清理默认开启，默认保留天数为 **5 天**，启动约 90 秒后首次扫描，之后每小时扫描。时间依据为日志修改时间与会话创建时间的较大值；缺少时间信息时跳过。安装后请在设置页核对该开关与保留天数。

删除事务默认等待上限为 30 秒。超时返回可能部分执行的状态，请先刷新核对结果再决定后续操作。

配置与上次运行摘要写入用户状态目录，不写入插件源码。默认位置为：

- Windows：`%LOCALAPPDATA%/dsh-plugins/archived-sessions/cleanup.json`。
- 其他平台：由系统状态目录或用户目录解析。

可通过 `DSH_PLUGIN_STATE_DIR` 或 `ARCHIVED_SESSIONS_CLEANUP_FILE` 调整落点。

## 安装

参见[仓库安装说明](../../README.md)。包名为 `dsh-plugin-archived-sessions`，bundle 配置位于本包根目录。

插件依赖 DSH 的 JSONL 会话后端及对应租约、工作区和会话服务。不同宿主版本需要先验证接口兼容性。

## 开发

```sh
node --check lib/index.js
node --check lib/client.js
node --test test/*.test.mjs
python tools/build-reasons.py --check
```

中文提示以 Python 生成器为源，生成后的 JavaScript 使用 Unicode 转义。修改提示后执行生成器，再运行检查。

[MIT 许可证](LICENSE)。
