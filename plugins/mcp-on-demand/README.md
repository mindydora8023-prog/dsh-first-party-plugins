# dsh-plugin-mcp-on-demand

让**模型自己**决定什么时候把一台 MCP 服务器挂进来、用完再放回去。设置页（侧栏「设置」→「MCP 服务器」）同时列出当前可挂载的服务器、哪几台正在挂载，也可以手动启用或释放。

## 为什么

DSH 自带的 `@deepseek-ai/dsh-mcp-manager` 会把 `config.servers` 里的每台服务器在宿主启动时全部挂载并常驻。像 REA 这种 170 个工具的服务器，无论这轮任务是不是逆向，它的工具定义都跟着每一次请求走，代价是实打实的 prompt token。以前的做法是人工在设置里开关，或者靠 magpie 的 library `agents` 数组 + `library sync` 重写配置——都要人参与。

这个插件把开关交给模型：工具定义留在插件配置里，`mcpod_enable` 时才 `ctx.mcpManager.register()`，`mcpod_disable` 时调用返回的 disposer 卸载。工具随之中途出现、随之中途消失，不重启宿主。

## 六个工具

| 工具 | 作用 |
|---|---|
| `mcpod_list` | 列出可挂载的服务器、用途、是否已挂载、TTL、目录是否过期 |
| `mcpod_find` | 在记住的工具名目录里搜索，不启动进程，也不把 schema 放进提示词 |
| `mcpod_probe` | 连上一台、记下工具名、再断开；不把服务器留在挂载状态 |
| `mcpod_enable` | 挂载一台；`name` 必填，`ttl_seconds` 可覆盖 TTL（0 = 不自动释放） |
| `mcpod_disable` | 卸载并关闭子进程，保留目录 |
| `mcpod_health` | 查看配置、已有挂载及目录新鲜度，可选做一次有界连通性探测 |

挂上之后工具名是 `mcp__<服务器名>__<工具>`，例如 `mcp__REA__binary_session`。

## 两道保险

1. **TTL**：每台服务器有自己的时长（见下表）。模型忘了 `mcpod_disable` 时到点自动释放，Ghidra/Java 子进程不会在后台挂一整天。
   已挂载时再调一次 `mcpod_enable`（可带新的 `ttl_seconds`）就是**续期**，不会重挂、不会重新付启动成本。
2. **卸载即释放**：插件被停用或卸载时，所有活着的注册都会 dispose（`ctx.effect` 里登记）。
3. **同时只连两台**：`maxConcurrent` 默认 2，范围 1 到 4。第三台的启用或探测会排队，不会并排再起一个 Ghidra。
4. **进行中的调用不被 TTL 切断**：`mcp__<name>__*` 调用开始时暂停倒计时，结束后再按空闲时长重算。

| 服务器 | TTL | 为什么是这个数 |
|---|---|---|
| `REA` | 30 分钟 | 导入目标 + 让 Ghidra 跑完默认分析本身就要几分钟，一次逆向任务常常 10 分钟以上；30 分钟够一段连续分析，又不至于挂了没人管。分析更久就用 `mcpod_enable` 续期。 |
| `agent-desktop` | 5 分钟 | GUI 自动化是成串的点击，几秒到一两分钟一段；留 5 分钟余量，避免一直占着一个 Windows 会话。 |
| 其他（未单独配置） | 15 分钟 | `defaultTtlMs` 的兜底值。 |

`mcpod_list` 对已挂载的服务器报的是**真实剩余时间**（续期后会变），对未挂载的报配置默认值。

启用不再固定等 400ms。它最多等 8 秒（不超过该服务器的 `startupTimeoutMs`），看到 `connected` 就返回；报 `failed` 时立刻卸载，不把一个起不来的进程留在工具表里。仍在 `connecting` 时也会返回，状态写明还在连。

目录写在 `%LOCALAPPDATA%\dsh-plugins\mcp-on-demand\catalog.json`，不进源码树。每台服务器最多记 80 个工具名和一行短说明，不记 schema。超过 7 天算过期，`mcpod_find` 不再用它。`catalogFile: false` 关闭落盘。

## 配置

```yaml
- id: mcp-on-demand
  name: 'dsh-plugin-mcp-on-demand'
  config:
    defaultTtlMs: 900000
    servers:
      example:
        transport: stdio
        command: node
        args: ['./server.mjs']
        startupTimeoutMs: 30000
        ttlMs: 900000
        description: One line saying when this server is useful.
        keywords: [example]
```

服务器名需匹配 `[A-Za-z0-9_-]{1,32}`；`transport` 为 `stdio`（需 `command`）或 `streamable-http`（需 `url`）。

## 实现上的两个坑（都实测过）

1. **`output.render` 必须返回 content parts 数组**，即 `[{ type: 'text', text }]`，不能返回裸字符串。宿主管线会接受字符串，但 `dsh-spill-policy` 的 `tools/post-execute` 钩子随后对它调用 `content.some(...)`，整个调用以 `content.some is not a function` 失败——看起来像工具没注册，实际是渲染契约不符。
2. **不要在 `inject` 里声明 `mcpManager`**。管理器改为在调用时用 `ctx.get('mcpManager')` 惰性取，避免与工具注册的作用域纠缠。

## 实测（2026-11-17）

```
mcpod_list                     -> REA: off / agent-desktop: off
mcpod_enable {name: REA}       -> RUNNING (connecting) -> connected
mcp__REA__binary_session       -> 真实返回（Ghidra 12.1.4 + JDK21 已被探测到）
mcpod_disable {name: REA}      -> released
mcp__REA__binary_session       -> Error: unknown tool "mcp__REA__binary_session"
```

最后一行就是"用完即关"的证据：工具真的从工具表里撤掉了。

## 文件

| 文件 | 内容 |
|---|---|
| `lib/index.js` | 插件入口，注册工具和目录提示段，卸载时释放服务器 |
| `lib/tools.js` | 六个工具的定义与渲染 |
| `lib/catalog.js` | 工具名目录的读写、过期与搜索 |
| `lib/limit.js` | 同时连接上限，以及同一台服务器的启用/探测互斥 |
| `lib/routes.js` | 设置页读取、启停与探测的 HTTP 处理 |
| `lib/client.js` | 设置页面板 |
| `lib/config.js` | 服务器定义校验 |
| `lib/state-dir.js` | 与 `shared/state-dir.js` 逐字节一致的副本 |
| `lib/define.js` | 与 `shared/define.js` 逐字节一致的副本（宿主那份在 app.asar 里 import 不到） |
