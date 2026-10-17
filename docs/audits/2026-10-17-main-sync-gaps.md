# 同步最新 main 后的主要缺口：环境、功能与重构

日期：2026-10-17（America/Toronto）；审计分支 `acceptance/map-authoring-pipeline`。
本报告对照[完整导航/AI 计划](../pipeline/navigation-ai-workflow-plan.md)，包括已授权的连续相机/IMU 跟踪。范围是检查与记录，不在本次审计中实现这些产品缺口。

## 1. 同步基线与总体判断

- 原有文档已提交，最近计划提交为 `3bb9ab1`，同步前工作区干净。
- 执行 `git fetch origin`，将远程 `main` **`2dfd1ef`** 合并到当前验收分支，合并提交 **`1922769`**，无文本冲突；没有把验收代码合并进本地 main，也没有推送/PR/部署。
- **身份/权限基础和 Web/API 发布管线已有实质实现及线上证据。主要缺口已转为产品服务接线、数据归属统一、真实导航资产与动态设备能力。** 当前分支仍有可复现的 CI 集成失败，不能据远程 main 绿色就视为当前验收分支可合并。

优先级：P0 阻塞下一条可验收真实闭环或当前分支合并；P1 是后续完整目标必需，但可在静态闭环后推进。优先级按验收路径而非模型能力宣传确定。

分类规则：**E 环境/外部准备**包括配置、运行服务、人工资产与设备；**F 功能**是尚缺的用户行为/API/后台处理；**R 重构/集成**是已有实现需要适配、迁移或统一。一个问题只给一个主要归属，相关项用编号交叉引用。

**Vectorizer.AI 真实 Key、订阅和真实自动转换不计入缺口**，它们是本赛程明确不启用的范围。IA 四楼 mock 的真实素材、入库和演示可用性计入 E-04；其前端接线和线上运行分别属于 F-04/R-03。

## 2. 最新 main 已经带来的能力

| 已有能力 | 代码/证据 | 不能据此推导的完成状态 |
|---|---|---|
| Google OAuth 后端入口、Django session、身份/退出接口 | [auth 路由](../../apps/api/accounts/urls.py)、[视图](../../apps/api/accounts/views.py)、[OAuth 记录](../backend-oauth.md)；本机 auth 测试随套件通过 | Angular 已接真实登录、普通邮箱认证已支持、真实 Google consent 已验收 |
| 按 MapTarget 的 admin/volunteer Membership、grant/revoke 服务、DRF 权限、启动管理命令 | [权限](../../apps/api/maps/permissions.py)、[成员服务](../../apps/api/maps/services/membership.py)、[诊断视图](../../apps/api/maps/views.py)、[功能记录](../backend-permissions.md) | 所有地图业务接口已存在，或 Node pipeline 自动继承 Django 会话/权限 |
| CI、受开关控制的部署、打包、迁移、健康检查与版本切换/失败处理代码 | [CI](../../.github/workflows/ci.yml)、[部署工作流](../../.github/workflows/deploy.yml)、[控制器](../../infra/deploy.py)、[打包](../../scripts/package_release.py) | pipeline/worker 全部上线、地图业务就绪、灾难恢复已实演 |
| 最新 main 已成功运行并部署 | [CI run 39038792613](https://github.com/mhamza1906/SnapWay/actions/runs/39038792613)：含 Linux/Windows backend、PostgreSQL、Web、package、deploy 成功；部署开关复核为 `true` | 当前验收分支已通过 CI，或包含本分支未推送的 pipeline 代码 |

公开只读 HTTP 观测（约本地 11:08）：`/api/health/live/` 返回 main 完整 SHA `2dfd1efcfd6a2008b5c4c6d3e6b43cb26202fd32`；`/api/health/ready/` 返回数据库 ok；`/api/auth/me/` 返回匿名身份，均为 JSON 200。这证明已部署基础运行，不证明 OAuth 实际授权或业务工作流完整。

相同主机的 `/pipeline/api/health`、`/pipeline/api/vectorization/status` 均返回 **200 HTML**，与[当前 Caddy SPA fallback](../../infra/deploy.py)和[发行包不含 Node pipeline](../../scripts/package_release.py)一致；它们不是工作的 pipeline API。不能只检查 HTTP 200。

## 3. E：环境与外部准备缺口

| 编号 / 优先级 | 实际状态与证据 | 补齐后如何验收 |
|---|---|---|
| **E-01 / P0：Google OAuth 实际配置** | 本机 `local/env/api.env` 的 `GOOGLE_OAUTH_CLIENT_ID`、`GOOGLE_OAUTH_CLIENT_SECRET` 为空。生产端凭据/Google Console consent、测试用户和精确 callback 未在本次读取/确认；不据本机状态断言生产也为空 | 配好本机与 HTTPS 部署回调，各完成一次真实授权；`me` 返回会话及目标 membership，退出后失效。Google 身份不自动授予地图权限 |
| **E-02 / P0：本机共享 DB 可达性** | 本机配置了 PostgreSQL URL，但只读 `SELECT 1` 返回 `OperationalError`；未输出连接信息或凭据。线上 readiness 数据库 ok，故不能报告“整个 Tiger DB 宕机” | 修复本机连接/网络/TLS/账号中的真实原因；只读连通和表状态核对通过后，再按成员授权进行迁移/种子准备。仅给出 URL 不等于连通 |
| **E-03 / P0：后台 broker/worker 运行条件** | Django 配有 Celery broker，但本机配置的 Redis TCP 端口不可达；发布控制器目前只生成 API 服务，未见两条业务队列的 worker 单元。实际 worker/队列消费者未验收 | 本地提供适用的 Redis/Celery 运行环境，部署侧配置 authoring/localization 消费者并检查容量隔离；还需 F-06 的真实任务实现，端口通不等于任务可用 |
| **E-04 / P0：IA 四楼 mock 预构建包** | 代码固定 `ia-4`，缺素材时明确 `503 DEMO_ASSET_PENDING`。本机 SQLite 只有 `ia-1` 的 440,127 字节 SVG；四楼真实源图/SVG 未入库；合成测试四边形不算素材 | 人工 Figma 四楼导出，核对楼层/比例/结构，按[导入命令](../pipeline/vectorizer-api-demo.md)入库并保存源哈希/来源。四楼 mock 实测返回该图和声明；一楼绝不顶替 |
| **E-05 / P0：导航 demo 的实地数据** | 一楼 SVG 显示资产已有，但仍 `navigationReady=false`；本次未发现一套已审核的 IA 路线图、米制校准、四向真实参考与独立查询照片组成的完整发布包 | 明确一条真实起终点路线，现场确认门洞/楼梯/朝向/距离，采集参考和独立验收图；发布后实地走通。优先一条短路线，不以全楼采集阻塞起步 |
| **E-06 / P1：目标 Android 真机与标定条件** | 仓库包含 Capacitor Android 外壳，但依赖清单尚无 Motion/ARCore/VIO；DevicePreview 明确是模拟。真机型号、相机/IMU 能力、调试连接和标定尚未验收 | 准备一台目标手机、可复测路线/锚点、相机与运动数据录制条件；按计划 §9.7 实测频率/时钟/漂移/暂停恢复。SDK/适配器开发属于 F-08 |
| **E-07 / P1：服务端模型/发信环境的发布验收** | 本机 OpenAI key 已存在，Vertex 参数存在于 Node `.env.prod`，并非全部缺 Key；这些存在性不等于服务器已配置或新 Flash 角色可用。普通邮箱的真实邮件发送条件亦未验收 | 先明确 R-04 的环境合同，再验证实际部署使用的模型入口/权限/额度及发信服务；用量/时间记录齐全。本次不发起任何模型请求，不要求购买 Vectorizer 服务 |

R2 四项本机配置存在，未做对象写入/凭据有效性测试。**不将“购买或重新开通 R2”当作必需环境缺口**：当前架构支持持久私有文件存储。缺的是 F-03/F-06 中可用、受权限保护的资产写入/交付服务；如决定使用 R2，再验收其适配与访问条件。

## 4. F：功能缺口

| 编号 / 优先级 | 与最新计划相比尚缺什么 | 现有基础 / 完成判断 |
|---|---|---|
| **F-01 / P0：真实前端身份与权限体验** | Google 登录入口、会话加载/退出、会员目标列表、无权限/过期恢复、带 CSRF 的写请求和真实身份路由行为 | 后端 `me/logout` 和 Membership 已有；前端 [welcome](../../apps/web/src/app/features/welcome/welcome.ts)、[settings](../../apps/web/src/app/features/settings/settings.ts)仍调用 `setRole`，没有完整 Auth facade。应替换演示角色入口，不能重复造另一套权限权威 |
| **F-02 / P1：邮箱密码 + 邮箱验证** | 原先确认的注册、验证、登录、找回密码与邮件投递流程尚未实现 | [base settings](../../apps/api/config/settings/base.py)为 `SOCIALACCOUNT_ONLY=True`、`ACCOUNT_EMAIL_VERIFICATION="none"`。这是普通邮箱认证范围缺失，不是对 Google 身份验证有效性的否定；如需暂缓，应显式缩小产品范围 |
| **F-03 / P0：地图业务 API 与发布闭环** | 目标/贡献/修订/资产 CRUD、成员操作入口、服务端图编辑/审核/发布、Public 发布读取和受控媒体交付 | [maps 路由](../../apps/api/maps/urls.py)当前只有 access 诊断；[模型](../../apps/api/maps/models.py)丰富但不能替代服务。新接口必须使用现有 membership/对象范围验证；初始成员可先用已有 Admin/命令，不必为 demo 重做启动机制 |
| **F-04 / P0：Image 2.5 产品化与构建演示接线** | 原图优化、直接看图、自然语言再生成、版本接受/回退及语义失效；IA-4 mock 的选择/响应展示/真实来源声明 | [真实调用实验](../../apps/pipeline/experiments/fullchain-pilot.mjs)已经有证据；[当前 authoring UI](../../apps/web/src/app/features/authoring/authoring.ts)未提供完整新链路。mock 路由本身已有，剩素材 E-04、部署 R-03 与 UI/任务编排接线 |
| **F-05 / P0：新版语义图与 Flash 编辑助手** | Gemini 4 针对接受图提议各类节点、标签/证据、走廊采样、完整边几何与距离关系；Flash 将自然语言转换为受约束 ChangeSet；人工修改/审核闭环 | Node pipeline 已有识别、局部几何、门洞、路由/校验和持久快照，**不是没有 AI 代码**。但[真实 IA 验收](2026-10-17-gpt-fullchain-pilot.md)未通过，且当前流程未覆盖新的三类模型职责/全套合同；需复用已验证部分并补测 |
| **F-06 / P0：四向照片及异步场景理解** | 四方向槽位/方位校准、非阻塞上传、用户干扰排除、Gemini 4 结构化描述、任务进度/有限重试/版本核验、关系复核和索引发布 | ReferencePhoto/SceneRelationship/Job/JobAttempt 仅提供持久化基础；[jobs 目录](../../apps/api/jobs/models.py)未见照片分析任务/派发服务；[Celery](../../apps/api/config/celery.py)只有初始化。现有 Node map-job 快照不等于照片理解 worker |
| **F-07 / P0：Public 静态实景导航** | 真实发布范围/起终点解析、拍照确认节点/方向、按路段出发朝向选真实照片、手动推进、到达/错误恢复；不展示室内地图的新流程 | [导航页面](../../apps/web/src/app/features/navigation/navigation.ts)依赖 PrototypeRepository/DevicePreview、模拟定位/到达；本地 Dijkstra 可运行，但实际导航 session/定位/路线 API 未存在。UI 改造归 R-05 |
| **F-08 / P1：动态相机与连续几何跟踪** | 相机与加速度计/陀螺仪、原生跟踪适配器、同源相机取帧、时间/坐标/epoch、锚定与漂移恢复、Gemini 慢路径融合、屏幕/世界坐标叠加 | [DevicePreview](../../apps/web/src/app/core/device-preview.ts)明确不调用硬件；当前无原生 Tracking 引擎。按计划 §9.4–9.7 分层验收；静态先行，不把模型自报节点当成完整相机位姿 |

定位图像/特征检索、候选集合和索引属于 F-06/F-07/F-08 的内部工作，不单独把“必须买某 embedding 服务”列为依赖。先验证指定 Gemini 方案，再据真实精度/延迟决定检索实现。

## 5. R：重构与集成缺口

| 编号 / 优先级 | 现有实现需要怎样调整 | 证据与边界 |
|---|---|---|
| **R-01 / P0：合并后的 CI 合同与脚本质量** | 统一 `classify_changes` 的三项返回值及测试；使实验/分析 Python 服从仓库 Ruff 规则，保留证据字节要求。修复后重跑相关检查再考虑 PR | [分类器](../../scripts/ci_changes.py)返回 backend/web/pipeline；[新增发布测试](../../infra/tests/test_package_release.py)仍期待两项，实测 7 失败。另有 3 个本分支旧实验/分析脚本累计 89 Ruff 诊断且格式检查失败。前者是无文本冲突仍出现的集成问题，后者是本分支既有质量债，不归咎于新 main |
| **R-02 / P0：统一数据权威与图合同** | 将 Local Storage prototype、Node building JSON/文件、Django revision/关系模型通过明确 DTO/适配边界统一；固定 ID、坐标、比例、边方向/权重/验证状态和发布版本，迁移现有草稿 | [PrototypeRepository](../../apps/web/src/app/core/prototype.repository.ts)、[原型模型](../../apps/web/src/app/core/prototype.models.ts)、[Node building schema](../../apps/pipeline/shared/building/schema.js)、[Django 模型](../../apps/api/maps/models.py)。前端 MapEdge 只有基本 blocked/accessibility，原型边双向且无米制比例；不是共享图的可直接等价序列化 |
| **R-03 / P0：把 pipeline/任务/权限纳入运行和发布边界** | 明确 Node 作为内部服务还是迁移所需流程进 Django worker；补发行资产/启动、队列、持久目录、受控代理与 readiness。复用 Django 的身份/MapTarget 权限，保持浏览器合同兼容 | 现有发行包不含 `apps/pipeline`，Caddy 无 `/pipeline` handler，线上实测 HTML fallback；Node 只有 Origin/loopback 边界，不验证 Django membership。**不能直接公开代理整个 Node 服务来完成部署**。这属于新增 pipeline 切片的集成工作，不把现有 Web/API 部署判作失败 |
| **R-04 / P1：环境、模型角色与存储配置合同** | 统一/明确 Django `local/env/api.env`、Node `.env.prod` 和生产 `/etc/indoor-nav/api.env` 的读取边界；配置 Image/Gemini/Flash 的角色、资产存储与预算记录 | 当前“唯一私密 env”文档主要描述 Django，与 Node 独立 dotenv 有范围歧义；生产模板还未包含新 pipeline 的模型运行合同。已有本机 key 不应无说明再复制多份，也不能因 R2 值存在就声称已启用存储 |
| **R-05 / P1：前端从通用地图原型转为新工作流** | Developer 以接受位图/图草稿/四向采集为中心；Public 以照片/相机为中心，拆除室内地图主视图与模拟结果/角色入口；保持已约定 API 边界 | 当前 [NavigationMap](../../apps/web/src/app/features/navigation/navigation-map.ts)与[导航模板](../../apps/web/src/app/features/navigation/navigation.html)仍面向地图和模拟推进。历史 prototype 可保留独立演示入口，不能混作正式用户流程。风格/布局/动画的整体迭代仍随新流程验收 |
| **R-06 / P1：从各层 mock 单测补到跨层真实合同验收** | 保留快速离线 CI，加入身份→目标权限→资产/任务→发布→静态路线的必要合同回归；真实模型/设备测试放本地或明确人工流程并共享精简结果 | 当前前端/Node 单测可通过，但不能证明跨进程/真实资产闭环。现有 CI `required` 只汇总运行/跳过结果，业务 readiness 仅 DB；需按切片增加必要检查，不把收费模型调用加入每次 CI |

R-01 的 3 个 Ruff 文件为 [meter_image_cli.py](../../apps/pipeline/experiments/meter_image_cli.py)、[stage_fullchain.py](../../apps/pipeline/experiments/stage_fullchain.py)、[Figma 分析脚本](assets/2026-10-17-figma-vectorization/analyze.py)。本次仅记录，未用跳过/排除规则隐藏检查，也未改写历史证据。R-02/R-03 的实施方式须作为具体切片定案；当前计划授权不等于可以未经评审替换队友已公开 API。

## 6. 本次验证结果与限制

| 检查 | 本次结果 |
|---|---|
| Git 同步 | main 合并成功，merge `1922769`，无文本冲突 |
| 最新 main GitHub CI/部署 | run `39038792613` 成功；线上 release 匹配 `2dfd1ef` |
| 合并分支 Python tests（API/MCP/infra） | **67 通过、16 PostgreSQL-only 跳过、7 失败**；失败均为 CI 分类器二项/三项合同不一致，约 23 秒 |
| 合并分支 Ruff | **89 诊断，3 个文件格式不通过**；不是“全部检查已绿” |
| Django system check / migration drift | 无 system check 问题；`makemigrations --check --dry-run --settings=config.settings.test` 无变更 |
| Node pipeline | **151 通过、18 既有可选 Waterloo fixture 跳过、0 失败**，约 4.5 秒；包括 IA-4 mock 离线合同 |
| Angular | **11 个测试文件、59 项通过**；浏览器 production build 成功。未在此审计重跑原生 APK/实机验收 |
| 配置/环境 | 本机 OAuth 两项为空、DB 只读连接失败、broker TCP 不可达；OpenAI/Vertex/R2 存在性检查不泄露值，也不视为有效性证明 |
| 公网 API | health/live、health/ready、匿名 auth/me 正常；pipeline URL 返回 HTML，未上线 |
| 人工资产 | 本机预构建库仅 `ia-1`；IA-4 mock 素材待配置 |

细化证据在忽略目录 `local/test-results/main-sync-gap-audit/`：`probe.py/probe.json`（只读配置/DB/端口/公开 HTTP）、`lint.json`（诊断聚合）。共享的[去敏验证快照](assets/2026-10-17-main-sync/verification.json)保留关键结果与基线，不包含真实 env 值、数据库连接串或用户记录。

本次不执行 Google consent、共享数据库迁移/写入、模型/Vectorizer 真实请求、R2 写入、SSH 部署或硬件测试。线上 readiness 仅检查 SQL 和基本用户表，不代表照片索引、作者任务或导航已经就绪。主分支与合并分支的检查结果严格分开。

## 7. 建议推进顺序

1. **先恢复可集成基线**：R-01；同时补 E-01/E-02，准备 IA-4 资产 E-04 和一楼短路线数据 E-05。CI/后端部署基础可以复用，无需重建整套发布系统。
2. **接身份与单一数据权威**：F-01/F-03 + R-02；明确 R-03/R-04 后接作者流程 F-04/F-05。先一条目标/贡献链路，不同时迁移所有页面。
3. **完成照片到静态导航**：E-03 + F-06/F-07，真实发布版本中验证参考照片、起点/方向、可走路线和到达；这是下一条完整产品闭环。
4. **再推进连续动态导航**：E-06 + F-08，按传感器读数→局部姿态→地图锚定→云端慢路径融合验收。F-02 邮箱认证若纳入首演示则需提前并行安排；否则明确列为保留需求。

人工补素材、部署配置和代码工作可并行准备，但“界面能点击”“schema 已存在”“模型能返回 JSON”“CI 绿色”各自只证明对应层，不能相互替代完成证据。
