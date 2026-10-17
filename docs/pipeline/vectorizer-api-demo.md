# Vectorizer.AI 接口与预构建地图 demo

更新：2026-10-17；分支 `acceptance/map-authoring-pipeline`。这是成员确认的新方案，取代[私人 Figma 中转站方案](figma-demo-bridge-proposal.md)。没有创建 Figma 插件、爬虫、订阅或真实 Vectorizer.AI 请求。

实现提交：`f65ac91`（本地，尚未推送）。

## 当前决策与完成边界

| 用途 | 楼层 / 数据源 | 当前状态 |
|---|---|---|
| 正式自动矢量化 | Vectorizer.AI 官方 HTTP API | 适配器和独立路由已实现；凭据为空，默认禁用；仅离线契约测试 |
| 构建 workflow 演示 | **IA 四楼 `ia-4`**，手工 Figma 导出 | mock 路由已实现；真实四楼素材待提供，返回 `503 DEMO_ASSET_PENDING` |
| demo route 地图 | IA 一楼 `ia-1`，以及后续手工准备的楼层 | 一楼现有 SVG 已导入本机 SQLite；房间、门、路线和跨楼层连接仍待完善/验收 |

**IA 一楼绝不作为 mock 默认值或四楼缺失时的替代。** 测试中的小矩形仅存在于隔离测试数据库，不是 IA 四楼成果。

商用接口接入代码与演示数据来源分开：真实路由出错不会切换到 mock；mock 不调用模型、不请求 Vectorizer.AI、不连接 Figma，也不伪造实时生成过程。展示 mock 时必须把响应的 `disclosure` 持续显示给观众：

> 存在自动化的可商业化的 API 服务，但我们没付款，此次只做效果演示。当前结果为手工通过 Figma 预构建的 IA 四楼矢量图，并非现场 API 生成。

已实现的是 Node pipeline 的可调用接口和入库工具，**尚未接入 Angular 的构建按钮、共享 PostgreSQL/R2 或导航发布流程**；原有 `/api/authoring`、map jobs 和队友的数据 schema 保持兼容。SVG 只承担显示底图作用，不能替代导航图。所有新资产均标记 `navigationReady: false`。

## 本地配置

使用仓库指定的 Node 24（含内置 `node:sqlite`），不增加 npm 依赖。配置在服务器端 `apps/pipeline/.env.prod`，参照[模板](../../apps/pipeline/.env.prod.example)：

```dotenv
VECTORIZER_API_ID=
VECTORIZER_API_SECRET=
VECTORIZER_LIVE_ENABLED=false
```

本阶段保持原样。API 使用 ID/Secret 两项 HTTP Basic 凭据，不能填入 GPT/Gemini Key；也不要放入 Angular 或公开文件。现有 pipeline 启动仍按其 Vertex 配置校验；mock 本身不需要任何模型密钥。后续商业启用前再核实账号权限、计费和[已记录的下游使用条款问题](../audits/2026-10-17-figma-vectorization.md)，本次不做付费激活。

## 手工 Figma 预构建与入库

1. 为每个楼层保留实际导入 Figma 的优化 PNG/JPEG。房间信息保留在独立语义记录中，不依赖已清除标签的图片恢复全部信息。
2. 人工导入 Figma Design，执行 Vectorize 并检查轮廓。只选该楼层矢量图导出 SVG；避免把底层位图一起导出。
3. 对照输入检查比例、朝向、裁切范围、门洞和楼梯；楼层身份由操作者确认，程序不能从无标签 SVG 自动证明是几楼。
4. 文件放入忽略目录，例如 `local/prebuilt/ia-4/optimized-floor.png`、`local/prebuilt/ia-4/floor.svg`，然后运行：

```powershell
cd apps/pipeline
npm run import-prebuilt -- --floor ia-4 --label "IA floor 4" --source ../../local/prebuilt/ia-4/optimized-floor.png --svg ../../local/prebuilt/ia-4/floor.svg
```

命令将 **SVG 原始字节 BLOB、两份文件的 SHA-256、尺寸、时间和手工来源** 保存至 `apps/pipeline/.local/vectorization/assets.sqlite`。该数据库已忽略，不会被推送；这是本地演示资产库，不是共享数据库。重复导入相同资产幂等；修改已有楼层必须明确加 `--replace`。尚未提供四楼文件时不要运行上述占位路径，也不要重命名一楼文件冒充四楼。

其他导航演示楼层使用各自 `--floor`，导入方式相同。一楼现有审计样本可在其他成员机器重建：

```powershell
npm run import-prebuilt -- --floor ia-1 --label "IA floor 1" --source ../../docs/audits/assets/2026-10-17-gpt-fullchain/optimized-floor.png --svg ../../docs/audits/assets/2026-10-17-figma-vectorization/figma-vector.svg
```

本机实际入库尺寸为 1536×1024；SVG SHA-256 为 `c7ec1165be27096017ab4f2a5b9aac9aaf5f0f1407845bd28c0aeeed0fc6f53e`，与[原始导出证据](../audits/assets/2026-10-17-figma-vectorization/figma-vector.svg)一致。这只确认存储完整性，一楼导航仍未验收。

未来接入共享数据库时，SVG 字节进入私有资产存储，路径映射到现有 `Asset.storage_key`，哈希、类型、尺寸和来源映射到[现有 Asset 模型](../../apps/api/maps/models.py)。需要真实 MapTarget 绑定和授权流程后才可创建共享记录；本次不伪造用户、Revision 或数据库写入成功。

## HTTP 合同

从 `apps/pipeline` 运行 `npm run prod`。直接地址 `http://127.0.0.1:5175/api/vectorization`；Angular 同源代理地址 `/pipeline/api/vectorization`。

| 方法与路径 | 输入 | 返回 / 约束 |
|---|---|---|
| `GET /status` | 无 | 密钥是否配置的布尔值、live 开关、固定 `mockFloorId: ia-4`、`pending-asset` / `asset-ready`、已入库楼层元数据；不返回密钥 |
| `POST /mock` | JSON `{"floorId":"ia-4"}`；可附 `sourceSha256` | 返回四楼固定 SVG；其他楼层 `422 MOCK_FLOOR_UNSUPPORTED`；四楼缺失 `503 DEMO_ASSET_PENDING`；提供的源哈希不匹配 `409 SOURCE_MISMATCH` |
| `GET /prebuilt/:floorId` | 例如 `ia-1` | 返回手工预构建底图；缺失 `404 ASSET_NOT_FOUND`；不会触发 mock 或模型调用 |
| `POST /live` | multipart：`image` PNG/JPEG，`floorId` | 当前 `503 VECTORIZER_DISABLED`；将来显式启用且有凭据才发送官方请求，不自动回退 |

mock 不接受任意输入图后假装完成矢量化：调用者显式选择固定四楼；有源图时同时发送哈希进行匹配。成功响应的公共字段：

```text
floorId, svg, sha256, sourceSha256, width, height,
provider, mock, navigationReady, disclosure,
metrics: { elapsedMs, upstreamRequests, creditsCharged, usd }
```

mock 的 `provider=prebuilt-figma`、`mock=true`、请求数和本次费用均为零；耗时仅代表本地读取/序列化前处理，不是 Figma 矢量化耗时。live 的 `provider=vectorizer.ai`，记录调用耗时与实际 credit 响应头；没有响应头则为 `null`，USD 不推测，超时也不能认定供应商未扣费。SVG 在 JSON 中返回；消费者应通过图片元素显示，不能直接插入不可信 HTML。

本地验证（当前四楼尚未入库，最后一步应返回 503）：

```powershell
Invoke-RestMethod http://127.0.0.1:5175/api/vectorization/status
Invoke-RestMethod http://127.0.0.1:5175/api/vectorization/prebuilt/ia-1
Invoke-RestMethod http://127.0.0.1:5175/api/vectorization/mock -Method Post -ContentType application/json -Body '{"floorId":"ia-4"}'
```

## 实现、验证和后续验收

- [资产校验与 SQLite 存储](../../apps/pipeline/server/vectorization/assets.js)、[手工导入命令](../../apps/pipeline/server/vectorization/import-prebuilt.js)、[npm 命令](../../apps/pipeline/package.json)。
- [官方适配器](../../apps/pipeline/server/vectorization/provider.js)、[新增路由](../../apps/pipeline/server/vectorization/routes.js)、[服务挂载](../../apps/pipeline/server/index.js)。
- [9 项离线测试](../../apps/pipeline/tests/vectorization.test.js)：SQLite 重开持久性、幂等与替换、楼层隔离、待配置响应、来源/费用声明、源哈希冲突、空密钥/关闭开关、Basic/multipart 契约、上游错误/超时/大小限制、危险 SVG 拒绝及 HTTP 成功合同。注入假 fetch，不连接供应商。
- `npm test`：169 项，151 通过、18 项因既有可选 Waterloo fixture 缺失而跳过、0 失败；约 4.8 秒。没有增加 CI 付费测试。
- 本机真实 SQLite/HTTP smoke：一楼 SVG 返回 440,127 字节且哈希一致；四楼 mock 返回预期 503；外部调用数为零。可重放脚本与记录在忽略目录 `local/test-results/vectorizer-api-demo/smoke.mjs`、`smoke.json`，不作为共享依赖。
- 后续必须补 IA 四楼真实源图和 SVG，完成入库与人工对照，再把 mock 响应及声明接入 Angular 演示界面；导航 demo 的房间/门/跨楼层图需独立完善验收。当前接口就绪不代表演示楼层或导航已经完成。

官方协议依据：[Vectorizer.AI 开发文档](https://vectorizer.ai/api/documentation)。适配器使用 `https://api.vectorizer.ai/api/v1/vectorize`、HTTP Basic、multipart `image`、SVG 输出和零天保留；设置 120 秒截止时间，不自动重试付费请求。该协议已按文档实现，但尚未经过供应商真实端到端验证。[Node SQLite 文档](https://nodejs.org/api/sqlite.html)说明内置存储接口。
