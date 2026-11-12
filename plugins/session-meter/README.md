# 会话费用估算

在 DeepSeek Harness 输入区显示当前会话费用，并为适用的 DeepSeek 模型显示峰谷时段。版本 0.3.0，MIT 许可证。

## 计算方式

- 按每次请求实际使用的模型和 token 用量计价，合计为当前会话费用。
- DeepSeek 模型优先使用内置价格表与峰谷规则。
- 其他模型通过在线目录匹配价格，再换算为人民币。
- 历史轨迹尚未完整加载时，差额按当前模型与时段补齐，并显示估算标记。
- 鼠标悬停可查看模型、单价、分模型用量与峰谷切换倒计时。

显示金额为估算，实际结算以模型服务商账单为准。内置价格和节假日规则需要随服务商调整维护。

## 外部数据

宿主端运行时可请求以下服务，并缓存结果：

- 价格目录：<https://models.dev/api.json>
- 美元兑人民币汇率：<https://open.er-api.com/v6/latest/USD>
- DeepSeek 内置价格表参考：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>

DeepSeek 条目不通过在线目录覆盖内置峰谷价格。外部目录不可达时可使用已有缓存；客户端仍可使用内置 DeepSeek 表。外部服务的可用性、数据条款及其更新节奏由相应服务维护。

本仓库不分发外部目录快照、个人会话日志或缓存。

## 安装与状态

参见[仓库安装说明](../../README.md)。包名为 `dsh-plugin-session-meter`。

诊断状态默认写入用户状态目录下的 `dsh-plugins/session-meter`，可通过 `DSH_PLUGIN_STATE_DIR` 或 `SESSION_METER_STATUS_FILE` 覆盖；价格缓存写入临时目录。

## 开发

```sh
node --check lib/index.js
node --check lib/client.js
node --check lib/prices.js
node --test test/*.test.mjs
```

测试使用本地替身，不请求真实价格或汇率接口。

[MIT 许可证](LICENSE)。
