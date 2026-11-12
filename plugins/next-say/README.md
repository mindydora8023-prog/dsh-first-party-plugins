# next-say：输入框内的下一句建议

DSH 插件，在空闲、空白输入框里显示模型预测的下一句话；输入草稿时，从当前会话已经发送的用户消息中做本地前缀补全。`Tab` 采纳，`Esc` 忽略，采纳只填入草稿。

本插件含 ferrisching/dsh-prompt-predict 的预测辅助逻辑改编。来源、改编范围和完整 MIT 通知见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。宿主接线、历史补全、ghost 排版、设置和测试包含本地开发工作；本说明不宣称全部代码均为独立原创。

## 使用与成本

通过所用 DSH 的插件安装入口使用本地包路径，或安装为 profile 的本地依赖。包内 `cordis.patch.yml` 提供注册行；安装流程以 DSH 版本为准。

- 输入框为空且智能体空闲：自动模式会请求一条下一句预测，**每次预测都是实际计费模型调用**。
- 开始输入：暂时隐藏预测；清空草稿可重新显示。同一回合运行后、采纳后或忽略后丢弃旧预测。
- 输入草稿：纯本地历史匹配，不发模型请求；只补剩余部分。
- 自动预测失败有最多一次回合重试，因而一个回合可能出现两次计费请求。默认超时为 12 秒。
- 预测读取最近用户和助手的纯文本，排除工具输出和注入上下文；数据会交给当前预测模型的提供方。

回合边界从宿主持久会话日志中的已完成 `turn/end` 派生，通过同源 `/next-say` API 供客户端读取。自动轮询本身不生成模型内容。预测不追加到会话日志。

## 设置

设置 → 下一句建议。保存位置为 DSH 用户目录下的 `next-say/settings.json`；显式 `DSH_HOME` 优先，其次 profile 路径，最后用户目录的 `.dsh`。

| 项目 | 默认值 |
|---|---|
| 启用 / 预测时机 | 开 / 自动，可改仅手动 |
| 建议长度 | 120 字符 |
| 参考消息 / 上下文预算 | 8 条 / 6000 字符 |
| 超时 | 12000 毫秒 |
| 本地历史补全 / 最少输入 | 开 / 2 字符 |
| 预测 provider / model | 留空跟随会话，两项均填才固定路由 |
| 暂停 | 可暂停十分钟，或立即恢复 |

当前 ghost 界面不显示预测按钮；切换“仅手动”会关闭自动预测，手动请求可由同源 API `POST /next-say/predict` 的 `{sessionId, manual: true}` 发起。API 同样使用宿主浏览器认证。设置词典中的“手动”文字不代表页面已提供相应按钮。

## 开发与可复现生成

需要 Node.js 22+ 和 Python 3.10+，无第三方 Python 包。Python 可执行文件按 `DSH_PYTHON` → `PYTHON` → PATH 上的 `python` 选择，环境变量值应是解释器路径或名称，不带参数。

```sh
python tools/make-locales.py --write
python tools/build-client.py
npm run check:client
npm run build
npm test
```

- `make-locales.py` 保存可读的中文和英文词典；`--write` 生成 ASCII 转义的词典，`--check` 在内存渲染后与生成物逐字节比较，不写盘。无参数时保留输出到 stdout 的用法。
- `build-client.py` 把词典、历史匹配和 ghost 模块内联进模板，生成宿主实际加载的单个客户端脚本。`--check` 检查已有产物，不写盘。
- `npm run check:client` 依次校验词典与客户端，两者任一陈旧即失败。这一步也覆盖“改了词典生成器却忘记生成词典”的情况。
- `npm run build` 目前执行 JS 语法检查；发布前应同时运行 `check:client`。
- 构建同步测试可能短暂改动发布检出中的测试源文件并在 finally 恢复；运行测试应使用独立检出，并在外层设置进程硬超时。Python 缺失时部分构建测试会显示 skip，发布校验入口则失败；CI 应显式安装 Python。

源码仓库应保留 `client/`、`tools/`、`test/` 和 `lib/`。npm 运行包白名单只包含运行时、元数据、文档及许可；安装运行包后不应假设开发生成器仍在包内。

## 实现与兼容性

- `lib/index.js`：完成回合扫描、同源路由、设置和有界模型请求。
- `lib/predict.js`：包含上游改编的预测提示、语言投票、预算、裁剪、净化及路由辅助逻辑。
- `lib/match.js`：历史前缀匹配和排序。
- `lib/ghost.js`：编辑器原点定位、隐形前缀排版、占位符恢复。
- `client/client.template.js`：客户端源码，设置及键盘采纳使用宿主草稿 revision 校验。
- `lib/locales.js`、`lib/client.js`：已提交的生成物。

清单声明支持 DSH `>=0.2.0-rc.2 <0.3.0-0`，这不是对区间内每个版本的实测保证。宿主升级后应复核 slot、编辑器 DOM 标记、草稿采纳、预测计费次数和路由认证。历史只覆盖当前会话；预测结果仍需用户判断。

## 许可

插件自身使用 MIT，见 [LICENSE](./LICENSE)。上游辅助逻辑保留 `Copyright (c) 2026 ferrisching` 及[完整 MIT 许可](./licenses/dsh-prompt-predict-MIT.txt)。运行包应随附本项目许可、第三方说明和 `licenses/`。
