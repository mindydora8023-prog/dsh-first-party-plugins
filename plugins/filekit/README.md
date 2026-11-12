# filekit

DSH 宿主插件，提供四个有界、只读的文档读取工具：

| 工具 | 内容与边界 |
| --- | --- |
| `filekit_read_table` | CSV/TSV 分页；分隔符和 BOM 检测，支持显式 UTF-16LE/BE |
| `filekit_read_docx` | DOCX 正文段落与表格；不解析页眉页脚、批注、图像或旧版 DOC |
| `filekit_read_xlsx` | 单工作表分页、日期与布尔值；公式显示缓存值，不计算公式 |
| `filekit_read_pdf` | 经典 PDF 的文本页；不进行 OCR，对部分字体和对象流存在限制 |

读取通过宿主 `ctx.fs`，受宿主文件访问规则约束；工具有输出预算、分页提示和取消信号。纯文本多文件读取由独立的 ops-lite 插件提供。

## 使用

需要 Node.js 22 或更新版本，以及提供 `tools`、`systemPrompt`、`fs` 服务的 DSH 宿主。将本目录作为本地插件依赖加入 DSH profile，再启用清单中 `dsh.bundle` 声明的配置。插件自带工具定义辅助实现，不要求从宿主安装目录直接导入 dsh-tools。

默认诊断状态存放在用户状态目录；可以通过 `DSH_PLUGIN_STATE_DIR` 覆盖，或通过插件配置 `statusFile: false` 关闭。配置项与默认值见 `cordis.patch.yml`。不要在插件目录保存真实凭据或运行时输出。

本发布目录保留 `private: true`，适用于源码分发或本地安装，尚未开放直接 npm 发布。运行包的白名单包含运行时代码、配置、本说明与许可文件；测试与生成器仅在源码分发中提供。

## 离线验证

```sh
npm run check
npm test
node test/make-office-fixtures.mjs --check
```

默认离线测试使用自带实现与合成数据，不访问网络、不读取真实账户。真实宿主比较测试在没有明确配置时显示跳过。若有一个兼容的宿主检出目录，可设置 `DSH_HOST_CHECKOUT` 为其中包含 `node_modules/@deepseek-ai` 的根目录，再运行测试；仓库不随附宿主代码或其依赖。

DOCX/XLSX fixtures 由本项目编写的最简 OOXML 与 ZIP 生成器产生，可重复生成：

```sh
node test/make-office-fixtures.mjs
node test/make-pdf-fixture.mjs test/fixtures/sample.pdf
```

这些生成器只使用 Node.js 内置模块。三个 OOXML fixture 不携带第三方默认模板、主题、缩略图或个人文档属性；日期测试保留自定义格式与未计算公式。PDF 不嵌入字体程序。

## 许可与来源

第一方代码按 MIT 分发，见 [LICENSE](LICENSE)。工具定义编译器与校验器含 DeepSeek Harness 移植部分，保留 `Copyright (c) 2026 DeepSeek` 及完整 MIT 原文。具体适用文件、素材来源和仍未完整追溯的项目见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
