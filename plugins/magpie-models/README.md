# Magpie 模型同步

DSH 的模型选择器只读 `llm-pi-ai` 里的 `providers.*.models`，设置页的端点发现不会落盘。本插件按间隔请求网关 `GET {baseURL}/models`，把结果写回这两条路由：

| 网关 `native_endpoints` | 写入 |
|---|---|
| `/v1/chat/completions` | `magpie` |
| `/v1/responses` | `magpie-responses` |

同时带两个端点的模型只进 Responses。没有端点的模型不写。网关失败或返回空列表时不改现有清单。清单没变就不写 profile。

思考档：网关的 `none` 写成 `off: none`；`ultra` 会并进 `max`（pi-ai 没有 ultra 这一档，已有 `max` 时保留 `max`）。网关没给输出上限时，保留该模型原先手写的 `maxTokens`。

默认每 5 分钟一次，`baseURL` 为 `http://127.0.0.1:3425/v1`。密钥只从环境变量 `MAGPIE_GATEWAY_KEY` 读，不写进配置；本机隧道不要求密钥时照样请求。

配置项：`enabled`、`intervalMs`（最小 15000）、`timeoutMs`、`baseURL`、`apiKeyEnv`、`chatProvider`、`responsesProvider`、`llmEntryId`。
