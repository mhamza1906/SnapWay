# 私人 Figma 账号作为矢量化中转站：hackathon 可行性评估

**已被取代（2026-10-17）：** 成员决定放弃中转站/自动插件方案，改为[Vectorizer.AI 接口代码与 IA 四楼预构建 mock](vectorizer-api-demo.md)。下文仅保留历史评估，不再是执行计划；IA 一楼用于独立导航 demo route。

日期：2026-10-17；分支 `acceptance/map-authoring-pipeline`，评估基线 `60e92cd`。
状态：**方案评估，未实现或运行中转链路**。遵循[现有架构](../initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md)，
应用 API、schema、依赖、Figma 文件和账号设置均未变更。

## 决策建议

**适合做操作者在场的 demo；不应承诺靠一个普通 Figma plugin 实现无人值守的完整转换服务。**
可自动化的是图片导入、选中矢量结果的导出和回传；公开接口仍缺少原生 Vectorize 的调用入口。
私人账号与非商业 demo 不改变这个技术边界，也不自动带来爬虫 / UI 自动化的许可。
实际矢量质量依据[此前本地 SVG 验收](../audits/2026-10-17-figma-vectorization.md)，不代表本次桥接已经打通。

| 环节 | 可行性 | 已知证据 / 未确认部分 |
| --- | --- | --- |
| Image 2.5 返回 PNG 后保存 | 已有隔离实验产物 | 本轮可直接复用 `optimized-floor.png`，验证中转时不必重复付费生成 |
| PNG 进入指定 Design 文件 | 支持插件实现 | Plugin API 创建 image + image-fill 节点，需用户打开目标文件并运行插件；导入尺寸与网络权限需校验 |
| 插件自动调用原生 Vectorize | 未找到公开入口 | 不能由 `createVector`、SVG 导出或插件自有 HTML 按钮推导出可调用原生功能 |
| 原生 Vectorize 由操作者运行 | 可作为 demo 中间步骤 | 本人已有该功能成功产物；实际配额、当前文件权限与响应仍需验证 |
| 桌面 / 浏览器脚本代点 Vectorize | 技术上可试，未验证 | 有焦点、选择、工具面板、生成完成、确认保存等 UI 状态；无法保证单凭截图就稳定执行，也不能视作官方 API |
| 从结果节点导出 SVG | 有受支持 API | `exportAsync({format:'SVG'})` 或 `SVG_STRING`；必须确认选中的是结果，不是仍带位图填充的输入 |
| 回传后端 / 写资产记录 | 可设计桥接，尚未接通 | 用现有存储 / Asset 概念；本地试验先保存文件与 SQLite 清单，不冒充共享 DB 已接入 |

官方依据：[图片导入](https://developers.figma.com/docs/plugins/working-with-images/)、
[节点导出](https://developers.figma.com/docs/plugins/api/properties/nodes-exportasync/)、
[原生 Vectorize 操作](https://help.figma.com/hc/en-us/articles/38031452710807-Convert-static-images-to-vector-layers)。
公开接口核查范围及固定版本见前一份 SVG 审计；没有发现可直接执行任意编辑器菜单命令的受支持入口。

当前会话也已提供 Figma connector 的 `upload_assets` / `download_assets` 能力，
可作为操作者 / Codex 发起的导入导出候选，未必需要先开发完整插件；本次只读其工具定义，没有上传或下载。
这不等于 SnapWay 后端能长期自行使用本聊天的认证连接；当前目标文件访问也未重新实测。
两种导入导出方式都没有补齐原生 Vectorize 的公开调用入口。

## 最小的可靠 demo 流程

建议只使用一个专用 Design 文件 `SnapWay · Vectorize Demo`，其中一个页面 `Vectorization Queue`；
同页按 job 分 frame，保留输入 / 输出，避免继续产生中间页面。名称只是建议，本次未创建文件或页面。

1. 后端实验脚本登记 job：输入 hash、1536×1024 尺寸、来源资产、目标地图 / 楼层及实验 ID。先复用现有 PNG。
2. **本人打开文件并执行 `Import next image` 插件命令。** 插件从受限下载地址或本地文件取得字节，
   创建对应 job frame 与原始大小的图片节点，绑定 job 信息、选中输入，然后保存检查点并关闭。
3. **本人执行 Figma 原生 Vectorize，确认结果。** 保留原输入以供叠加检查；不得把图片被选中或出现新节点就当成转换完成。
4. **本人选中输出并执行 `Submit selected vector`。** 插件检查 job 归属、原始输入与结果对应、导出尺寸，
   导出 SVG / PNG 预览，再上传至受限的实验接收端。不依赖手动下载目录和浏览器文件名。
5. 接收端验证、保存并记录结果为 `unreviewed`；应用展示可以加载这个候选资产。
   后续仍需独立的房间 / 门洞 / graph 标注与审核，不能把 Figma 输出直接宣布为可导航地图。

因此不是“插件按钮只点一次”的承诺：用户要启动导入、完成原生 Vectorize、再启动提交。
关闭导入插件后再运行原生操作，可以避免把插件和编辑器操作同时可用当作前提；具体 UI 次序需 smoke test 确认。
插件只能操作当前打开的文件上下文；fileKey 不是把普通 plugin 变成远端跨文件写入服务的凭证。

Figma 官方说明用户通常需发起插件动作，每人只能运行一个插件 / 动作，插件不作为后台常驻程序。
一个已启动插件可保持运行直至关闭，但这不等于关掉文件后还能处理队列。
[插件简介](https://developers.figma.com/docs/plugins/)、[运行模型](https://developers.figma.com/docs/plugins/how-plugins-run/)

## 网络、回传与现有数据库

插件可在其 UI 与后端交换数据，需配置精确的 `networkAccess.allowedDomains`；开发机器可使用 `devAllowedDomains`。
Figma 网页到 localhost 的 CORS、浏览器本地网络权限和 HTTPS 行为必须现场验证，不能假定桌面可用就等于网页版也可用。
最小导入可先用插件文件选择器读取本地 PNG，以便将“网络连通”和“原生矢量化”分开验收。
[网络请求](https://developers.figma.com/docs/plugins/making-network-requests/)、
[manifest 网络权限](https://developers.figma.com/docs/plugins/manifest/)

后端无需接管私人 Figma 的登录 Cookie 或密码。本人操作自己的 Figma 会话，插件只持有短期、单 job 的导入 / 提交凭证；
模型 API、数据库与 R2 密钥仍在现有服务端私有环境。job 归属和应用用户权限独立于 Figma 账号，不能把私人账号等同应用管理员。
可复用的插件中不嵌入长期服务端密钥或公开任意数据库写接口。

“下载回 database”应拆成资产保存与元数据登记：

- SVG / PNG 保存到配置的私有媒体存储，DB 保存 key、SHA256、类型、大小、尺寸、来源和 job 对应。
- 现有 [Django Asset](../../apps/api/maps/models.py)已有 `kind=svg`、`storage_key`、`source_asset`、`provenance`；
  `storage_key` 明确不是 blob、签名 URL 或凭证，不需要为存一张图先改生产 schema。
- 记录输入 hash、job ID、Figma 输入 / 输出节点关联、插件版本、转换设置、时间与 credits。
  原生功能可能重新生成节点；不能只按图层名或假定自动继承 `pluginData` 就关联成功。
- 入站 SVG 检查脚本 / 外部引用 / 位图嵌入、尺寸、字节上限与 hash，安全渲染为预览；
  重复提交同一 job 不重复建资产，重新转换输出保留新版本而不覆盖已验收资产。
- [Node BuildingSchema](../../apps/pipeline/shared/building/schema.js)的实验 assets 是 data URL 模型，与 Django 存储适配不是同一个落库契约。
  当前隔离实验未打通共享 DB / R2 写入；先用 `local/` 文件与 SQLite 登记即可，不声称生产落库已完成。
  Asset 可空上传者也不代表 Revision / authoring job 可以伪造或省略 required actor。

最小持久状态建议为：`pending → imported → waiting_for_operator → ready_to_export → stored_unreviewed`；
这是一份实验状态建议，不新增或替换现有应用 API。

## 全自动 UI 路径的边界

在本人登录的电脑上，受控浏览器 / 桌面助手有可能完成选择输入、点击 Vectorize、等待和确认；
但普通 Figma 插件在沙箱内，自己的 iframe DOM 不提供操纵宿主编辑器菜单的标准途径。
UI 自动化是独立的外部控制层，插件本身并未获得 Vectorize API。

演示中最容易失败的地方是登录或权限提示、选错节点、结果尚未完成、布局 / 语言变化，以及 credits 耗尽。
若进行单独 PoC，应限定单任务、显式可观察状态和超时，提交前再次校验纯矢量；出现异常由本人接管。
不靠固定 sleep 宣称生成完成，不因超时反复点击造成多次计费，也不将手工生成的旧缓存冒充现场结果。
在现场稳定性实测与平台允许范围未确认前，推荐保留第 3 步人工操作作为主 demo 路线。

Figma [AUP](https://www.figma.com/legal/aup/)对程序化访问保留明确许可条件，也限制共享账号和规避费用；
没有在本次阅读文本中找到 hackathon / 非商业自动豁免。
普通 Plugin API 的导入 / 导出有官方文档支持；未公开接口爬取、重放内部请求或 UI 爬虫不能自动视为同等获准。
本评估不认定所有本人 UI 辅助操作都被禁止，亦不将用户的 demo 意图解读为共享登录或绕过付费。

## 成本和产物使用

原生 Vectorize 仍消耗账号额度，当前官方表为 **2–5 Figma AI credits / 图**（表标注截至 2026-10-15）；
不是把个人账号放入流程后转换就免费。已有额度充足时可能无需另购矢量化服务，但未核查本人的额度和结算设置。
测量时分开记录导入 / 上传网络时间、原生转换时间、人工等待、credits 和总用时，不能与两阶段模型调用耗时直接当作等任务比较。
[credits 说明](https://help.figma.com/hc/en-us/articles/33459875669015-How-Figma-AI-credits-work)

Figma [AI Terms](https://www.figma.com/legal/ai-terms/)第 2 条将输入输出视作 Customer Content，并在双方之间保留客户权利；
这与此前商业描摹工具的专门 AI 用途限制不应混为一谈，但仍需按自身输入授权、Figma 适用条款和供应商条件使用。
该条款也区分 Figma 与独立 Weave 产品，不能将两者配额 / 权利自动等同。没有对产物后处理给出全面法律保证。

## 新发现：可另查 Weave 官方调用能力

本会话 Figma connector 已暴露 Weave 工具目录、输入契约、资产上传、运行和结果轮询能力。
这比爬取内部 Vectorize 接口更值得作为自动化候选调查，但 connector 能力不等于 SnapWay 后端获得了公共 API 凭证或服务许可。

本次只调用一次只读 `weave_list_tools(search="vector")`，返回：**当前 Figma 账号尚未关联 Weave**。
工具给出的关联入口为 `https://app.weavy.ai/settings?section=profile`；没有运行模型、上传图片或消耗生成 credits。
目前还不知道该账号的实际目录、输入输出格式与某个矢量工具的可调用性。

官方 credits 表另列 Weave 的 **Image to vector：13 credits / 次**，不同于原生 Vectorize 的 2–5；
不能推断两者同一引擎、同等效果或同样输出纯 SVG。独立 Weave 的账户 / credits 也与在 Design 内使用工具有区别。
[Weave in Figma](https://help.figma.com/hc/en-us/articles/40779260614935-Use-Weave-tools-in-Figma)

后续若要调查此路线，先关联账号并读取工具契约，确认返回实际 SVG、生成方式、价格与适用条款；
再用同一冻结 PNG 测一次，和现有 Figma SVG 比较几何。不能在目录未读到时声称已找到完整 API 替代方案。

## 最小验收次序

1. 同一 PNG 经插件进入目标文件，尺寸 / hash / job 对应正确；无新增生图调用。
2. 本人完成一次原生 Vectorize；导出插件识别正确输出，回传真实 SVG 与渲染预览。
3. 接收端保存文件、SQLite 元数据与测量记录；关插件后重新打开仍能恢复 job，对重复提交与选错图片能明确处理。
4. 视觉质量不低于手工导出基线；保留原图信息与待审核状态，不宣称已通过导航连通验收。
5. 若上述通过，才另行评估 UI 自动操作或 Weave；需要时再提出应用服务 / 存储接入的具体变更。

本次完成文档与官方能力核查，另有一次 Weave 只读连通检查；未开发插件、未设置账号、未创建 Figma 页面、未写数据库。
