# Herdr 两套适配：模块、函数与代码契约

状态：本文规定的 Herdr TUI / App 业务适配已随 Agent Bridge 0.6.0 发布到 npm 和 GitHub，头头、探探及五个维护中的 Connector 已同步上线，见 [发行和部署核对](../audits/2026-11-09-v060-release/README.md)。包含目录、生命周期、输入与只读恢复、IM/Web、公共文件/共享/完整 IDE 和 Taskboard 能力分离；原生未提供的模型/审批/队列等强语义不伪造。改前基线 Agent Bridge 37b2a2c（0.5.0）仅用于历史比较。固定上游快照 TUI 0.9.5 / ee5bfb5、App 0.1.13 / cfcf836、App 依赖 core 0.1.18 / c6b316f。功能证据见 [四层清单](../audits/2026-11-07-herdr-adapters/production-checklist.md)，终端展示以 [单卡窗口合同](modules/terminal-presentation.md) 为准，环境见 [实机记录](herdr-test-environments.md)。

## 1. 范围与事实源

适配 Herdr TUI 和 Herdr App。TUI 的执行与目录来自其 JSONL socket API；App 的执行来自其正在使用的 core，空间/标签/布局来自 App 界面或同一 core 上的 App 文档。Gateway 不启动第二个 agent，不在连接失败后切换执行器，不把 Herdr 内运行的 Codex 偷换成 Codex App Server 连接。

Connector 的路由、三元授权、文件、IDE、凭据和版本协商继续复用。协议解析属于设备侧适配器；频道、Web、Taskboard 不允许按 Herdr TUI/App 写两套业务流程。

先保持现有 Codex 行为，再引入能表达不同事实强度的运行接口。`CodexBridgeBackend` 是现有调用者的兼容边界，不能直接让 Herdr 实现里面的原生轮次/队列/审批语义。也不做一次没有行为收益的全库改名。

## 2. 从 Herdr 多 agent 实现得到的依据

| 上游职责与文件 | 实际方法/数据 | 对本项目的约束 |
| --- | --- | --- |
| TUI `src/detect/mod.rs` | 前台进程/命令识别；区分交互 CLI 与非交互脚本 | 识别到 agent 不代表取得它的原生协议；不要从进程名推导模型/审批能力 |
| TUI `src/detect/manifest.rs`、`manifests/*.toml` | 有版本的屏幕、OSC 标题匹配规则 | 检测规则是观察证据，不能当原生提交回执或完整历史 |
| TUI `src/pane/agent_detection.rs` | `decide_detection_transition`、`decide_screen_detection_publish`、延迟 idle 确认 | 安静、idle、进程退出与业务成功是不同事实；不能用一个布尔 completed 代替 |
| TUI `src/integration/registry.rs`、`targets.rs`、`assets/*` | 专用 hook/plugin、安装版本、状态与会话身份 | 专用集成与通用 PTY 互补；Bridge 不再复制一套屏幕检测规则 |
| TUI `src/app/api/agents.rs` | `validate_agent_prompt` 拒绝 blocked、启动未就绪、前台 agent 已换；提交等待 PTY 写入 | 普通消息只走 `agent.prompt`；不能在拒绝后退回 send_keys 绕过对话框 |
| core `templates.rs` | `Template`、`first_message`；ready/report、submit/stop/paste gap | agent 的启动/键位留在 Herdr 模板中；Bridge 不按 Claude/Codex/OpenCode 写启动分支 |
| core `status.rs` | OSC 7501 原样状态；离开 working 就增加 turn，包含 blocked/error | core.turn 只能作为观察序号；不能填入 Codex turnId |
| TUI `src/api/schema/agents.rs` 与 core `api/types.rs` 的读取合同 | TUI 提供 state_change_seq/completion_seq；正文按 source/lines 读取，core 按 terminal/lines 读取 | 有轮次相关状态，但没有“按 turn 返回最后一轮正文”参数；终端卡可能包含窗口内旧问答 |
| core `terminals.rs` | address、pid、foreground、keep、reason；PRIVATE 会删除 holder/program_started_ms | 地址可保留而程序替换；公开协议只能核验可观察身份，不能读取内部字段假装有原子实例校验 |
| App `mirror.rs`、`mirror_sync.rs` | spaces/tabs/layout 文档及 CAS | 空空间必须保留；UI 布局不等于执行目录；修改布局需要原生命令或 CAS |

以上来源已检查所列结构和分支；不是宣称阅读过整个 Herdr 仓库。完整接口和命令差异见 [协议调研](agent-runtime-interface-research-2026-11-06.md) 与 [命令对照](agent-command-compatibility-2026-11-07.md)。

## 3. 模块设计

| 模块 | 输入/输出 | 所有权与禁止事项 |
| --- | --- | --- |
| `src/agents/contracts.ts` | 运行身份、资源、能力、输入交接、观察与输出的判别联合 | 不依赖 IM、Web、Codex SDK；缺失信息显式 unknown |
| `src/agents/config.ts` | version=1 的严格 TUI/App 配置、工厂和 endpoint 身份 | 无环境猜测/默认切换/daemon 启动；配置路径与 core 身份变化使绑定目标改变 |
| `src/agents/json-line-client.ts` | 有界 JSONL 请求/响应、精确 id、超时与断连 | socket 连接、帧缓冲和 pending 请求；不重发写请求，不自动启动 daemon |
| `src/agents/herdr/tui.ts` | TUI 公共 API 到统一资源/输入/观察 | terminal_id 是执行身份，workspace_id 是展示分组；不使用易变的名字作写入目标 |
| `src/agents/herdr/app.ts` | App 空间目录 + 同一 core 的终端接口 | core.id 与终端地址共同定位；保留程序实例与屏幕完整性，不把窗口 socket 当执行 API |
| `src/agents/handoff.ts` | version=1 交接意图/确认/未知记录及同来源去重 | 仅保存输入指纹和证据；跨进程重建不补发；不是执行队列，不记录终端任务成功 |
| runtime-command-policy / operation contracts | 全 36 命令目标及 17 操作的能力判定 | Gateway/目录/绑定/原记录分别解析；角色、能力和来源分别核验 |
| Connector 装配 | 显式选择一个 runtime，注入已有传输服务 | 不因断连改 runtime；原 Codex 配置默认行为兼容 |
| Gateway 交接/观察 | 保存来源、精确目标、交接证据，异步跟随事实 | 观察器与执行器解耦；重启恢复观察，不补发未确认输入 |
| 命令/卡片/Web | 统一操作判定结果、结构化输出与可用控制 | 终端屏幕不运行附件 action block，不作为模型 final，不伪造审批按钮 |

## 4. 函数级契约

下表“当前问题”描述改前基线，用来解释改造理由；各行是否已实现以[生产检查清单](../audits/2026-11-07-herdr-adapters/production-checklist.md)为准，不能将本表当作现网缺陷清单。

### 协议边界

- `JsonLineClient.request(method, params, options)`：每个请求唯一 id；连接失败发生在发送前才是 not-sent；调用 write 后没有合法响应则 unknown。TUI 普通调用每次独立连接，App/core JSON-RPC 使用长连接；不是发送失败后重连重发。只匹配同 id 的响应；通知单独处理；帧超限或无效 JSON 关闭该连接。close 不等于任务停止。不得把远端正文写入普通日志。
- `HerdrTuiAdapter.describe()`：核验公共接口能力和版本；不能把 TUI 私有 endpoint protocol 22 当外部协议 generation。
- `HerdrAppAdapter.describe()`：先 hello 验证 core generation 1、core.id、方法表，再读 App 状态/目录；App 不在线不静默换到另一个 core。
- `catalog()`：保留无会话空间，明确 catalog complete/warnings；不合并 Gateway 本机 Codex 存储，不因一项错误伪造空列表。
- `inspect(ref)`：精确 resource id；输出生命周期、当前 agent、cwd、证据来源和实例。请求中的 ref 必须属于所配置 endpoint。TUI 必须由 snapshot 把保存的 terminal_id 解析成当前 pane_id，再 agent.get 核验；其 agent API 不直接接受 terminal_id。
- `send(input)`：写前重读目标，核验实例、状态；权限 callback 交给 RPC，在连接 await 之后、实际 socket.write 之前同步执行；异步 callback 拒绝，不把 Promise 当批准。使用原生 prompt/send，禁止 force。结果只声明 terminal-written/native-accepted 等实际证据，不从“工作状态出现”推导用户消息 id。
- `read(ref)`：读取终端画面，携带完整性和来源；App 使用 lines=0，避免后台观察滚动用户终端。不给屏幕文本赋 assistant/final 身份。
- `interrupt(ref)`：只中断精确终端当前程序；返回 requested/observed 等结果。TUI 按键发出不等于任务停止；不调用 server.stop 或 kill 整个 Herdr。
- `close()`：关闭 Bridge 自己的观察连接；不关闭 Herdr，不关闭窗口、不杀终端。
- `runtimeEndpointId(config)`：对解析后的 kind、配置 ID、socket 路径和 expectedCoreId 计算身份，JSON 属性排列不影响结果；不复用同名但已换服务的授权。
- `RuntimeHandoffJournal.get(key)`：writing 经重建/重取视为 unknown；不推断未发送。坏 JSON/坏版本拒绝加载，不覆盖原文件；相同进程状态目录必须沿用 Connector 独占进程锁。
- `RuntimeHandoffCoordinator.sendOnce(input)`：来源 principal/source/operation 定位记录；目标、实例、目录、正文指纹必须一致。写前 fsync；终端交接串行，不把任务整个运行期锁住。重复操作只返回原记录；not-sent 的显式重试也要新的受控操作，不能悄悄重发。确认后来源失效仍保存原回执，投递是否允许另由调用者判断。

### 当前调用链必须改动的位置

| 文件/函数 | 现有假设 | 需要的行为变化 |
| --- | --- | --- |
| `peer/index.ts/main` | 配置只接受 app-server，直接创建 CodexBackendRouter | 抽出有判别字段的 runtime 配置和工厂；Herdr 不读取 Codex home 或导出其 SSH 主机 |
| `peer/registry.ts/descriptionSchema` | id 仅 exec/app-server；能力都是布尔 | 发布 runtime 协议版本、资源种类和证据能力；旧 Connector 按已知 Codex 语义读取 |
| `peer/execution-service.ts/create/execute` | run/receipt/callback 假设 native turn；所有目录使用 Codex monitor | 分开执行写入与状态观察；复用权限回调与 durable receipt；Herdr 不创建 Codex rollouts monitor |
| `peer/backend.ts/invoke` | onTurnStarted 才能释放重启门禁；断线按 turnId 恢复 | 通用交接证据单独处理；只有原生接收才走 Codex receipt observer；终端观察不产生 native turn |
| `peer/receipts.ts/begin/accepted/complete` | phase 同时覆盖输入和任务结果 | 交接证据、观察状态和结果投递独立；相同 operation 重取旧回执，不能重写 PTY |
| `bridge/turn-submission.ts/TurnSubmission.run` | accepted 必有 turnId，completed 表示 run 返回 | 保存判别交接类型；unknown 无自动重试；收到终端画面不把输入标为任务完成 |
| `bridge/service.ts/runCodexTurn` | 所有结果 parseActionBlocks，success=true，默认“处理完成” | 终端输出经专用呈现，不执行其中 action；明确观察结果，进度/成果/IDE 继续用统一 presentation |
| `bridge/service.ts/handleActiveSessionMessage` 等 | 运行中默认 steer/queue | 根据 native-turn steering 能力决定；terminal.send 不能冒充 steer/queue |
| `bridge/restart-work.ts` | scope 必有 native turnId | 门禁只保护未完成交接，观察用有类型的 scope；不因长任务锁重启 |
| `bridge/native-input-recovery.ts` / 恢复协调 | 从 native userMessageId/turn 回执对账 | 仅 native-conversation 使用；Herdr unknown 保留并显示，不按文本比对去重或重放 |
| `channels/turn-status.ts` / `progress.ts` | 终态默认 completed/failed | 增加观察语义，blocked/unknown 不生成成功勾或留一个假完成 /stop |
| `bridge/channel-commands.ts` / `service.ts` | 帮助与执行门禁分散；model/effort 无能力登记 | 同一操作表检查帮助、按钮、别名、手写命令；不支持的原生操作给具体原因 |
| `server` 的会话、配置、Taskboard 路由 | 可绕过 IM 判断直接调用 backend | 所有写入仍在设备边界再验证；Web/Taskboard 使用相同 operation contract |
| `peer/ide-service.ts` / `files.ts` | cwd 是当前 host 的文件系统 | Herdr core 的 machine/t7 不能使用 Connector 本机 fs；按实际 machine 导出独立主机或显式拒绝未建立文件通道 |

## 5. 状态、持久化和兼容

资源身份分四层：Connector host、runtime endpoint、resource id、program incarnation。目录展示 ID 与执行目标不能互换。App 公共记录可用 core.id/address/created_ms/pid/foreground，holder/program_started_ms 是 PRIVATE，不能作为适配依赖。TUI 使用 terminal_id/agent/session 的可观察组合。缺失身份允许读取并标注未知，但不据此授权普通输入。上游不支持原子 compare-and-write，PID 复用或同种 agent 无 session 身份时仍有检测盲区；不能声称已实现跨程序替换的原子防护。

持久化保留：绑定、权限、来源 operation、交接阶段、终端实例/观察游标、卡片投递回执。模型、effort、Plan、Herdr 模板等原生设置不在 Gateway 保存覆盖值。新结构使用显式版本、迁移和反向兼容检查；同名 endpoint 配置变化不得复用旧身份。

状态至少区分：未发送、写入结果未知、终端已写入、原生已接收；运行/blocked/error/idle/退出的观察；结果已保存/投递待确认/已送达。任何任务成功结论必须注明依据，终端 idle 只表明观测到停止工作，未必业务成功。观察器重连不触发 send。事件丢失只重取快照；完整历史缺失继续标注。

审批：Codex 原生对象仍用现有精确请求与答案链路。Herdr blocked(kind=permission/question/auth) 只产生待处理提示和画面，不把原文正则转换成可批准对象，不自动发送 yes/Enter。后续具备结构化交互的 runtime 可实现同一 interaction port。

文件、IDE与共享：复用已授权的 host+resource+目录。未掌握实际 cwd 的空空间可显示但不能凭显示名获得文件权限。远程 machine 的目录不能在 Connector 本地解析。复制、@、IDE footer、终态和阶段卡规则继续由 Gateway 呈现层统一负责。

## 6. 全部命令的实现策略

Gateway 本地管理继续提供：help/connect/access/role/share/join/unbind/leave/project 登记、prompt 缓冲、stream 展示、inbox 回执。sessions/project/status/history 根据 resource/输出类型呈现；history 终端画面必须标为终端画面。new/rename/lifecycle 按原生操作细分；Herdr 没有 Codex archive 语义，不能等价成关闭终端。

model/effort/plan/goal/balance/steer/queue/approve/reject/answer/skip 的原生执行部分在 Herdr 没有等价契约；帮助注明、按钮不提供、typed/Web 写入明确拒绝。只读 Gateway 回执管理（例如 queue list）不因缺原生 enqueue 而整体删除。Taskboard 的数据管理保留，自动执行/QA/结构化工具按具体 operation 判定，不通过关闭整个模块掩盖不支持的节点。

## 7. 验证清单

- [ ] JSONL：分帧、多个响应乱序、Unicode、通知、非法 JSON、字节上限、超时、发送前失败/发送后断线、close 清理。
- [ ] TUI：版本与 capability、空 workspace、同名 agent、按 terminal_id 定位、blocked 拒写、前台变化、prompt 回执不伪造 turn、画面标签。
- [ ] App：hello generation/core id、空 space、layout 引用、已退出 terminal、kept terminal 换程序、screen 完整性、read 不滚屏、send false/null 不重试。
- [ ] 交接：原生写成功但回执丢失、Connector/Gateway SIGKILL、同来源幂等、撤权/换绑发生于 await 中、老 callback 到新绑定。
- [ ] 命令：36 个 canonical command、22 aliases、子操作/帮助/旧按钮/Web/Taskboard 一致；保留 native Codex 操作。
- [ ] 呈现：阶段/实时区/续卡、block/unknown 不假完成、原生审批 @ 与恢复新卡、IDE footer、文本复制、终端文本不能触发 send action。
- [ ] 文件：local/machine 作用域、入站附件、输出路径、共享只读/完整 IDE、无 cwd 空项目不能得到文件权限。
- [ ] 配置/发布：旧配置不变、显式 runtime、版本协商、运行制品身份、未知 runtime 拒绝、断连不降级、两环境验证后才可称支持。

四层检查按实际修改文件登记：架构契约；模块入口到故障与恢复；函数与代码分支；静态配置/文档/构建/迁移。每项填写具体测试名与结果，不能用旧版 427 case 总数代替此次增量验证。各组合的当前结果见 production-requirements.json；隔离测试、真实两端测试、手机与现网验收分别登记，不能用底层单元测试把整组勾掉。

## 8. 生产接入的代码级改造顺序

以下保留设计与迁移目标，当前完成范围以第 9 节及生产检查表为准。不能通过增加两个枚举后让终端实现 `run()` 完成接入。

### 8.1 保留完整功能的分面接口

统一的是业务语义和类型，不要求所有产品有同一个底层协议。实现分为 `AgentRuntimeAdapter`、typed RPC 与兼容目录三个边界，覆盖资源目录、输入交接、观察、生命周期、原生控制、交互、文件七个分面。Codex 由兼容适配层实现既有全部端口；Herdr 由本轮协议适配器提供真实终端事实。调用层按结果种类分派，不写 `if herdr-tui` / `if herdr-app` 业务分支。

| 现有 Codex facade 端口 | 统一层归属/实际迁移方法 |
| --- | --- |
| backendInfo、serverIdentity、getRuntimeInfo、warmUp | identity/health；分离服务身份、可选原生账号状态与连接预热；Herdr ping 不能表示 agent warmup |
| listProjects、listThreads、listSessionCatalog、inspectThread、readThreadProvenance | catalog；保留项目空组、目录来源、完整性、machine；既有 thread ID 以 conversation 类型保存 |
| getHistory、getHistoryPage、readThreadSnapshot、readTurnActivities、readTurnLifecycle | observation；transcript、native activity、terminal-screen 判别联合；只有原生分面提供原生轮次历史 |
| run、submitThreadMessage、steer、runEphemeral | input/native execution；普通新消息走 typed handoff，已有 Codex 流式/工具事件仍转交原实现；working 中的终端输入另有语义，不能投影成 steer |
| stop、interruptTurn | lifecycle control；目标必须含资源和实例；native cancellation 与 terminal interrupt-requested 分开 |
| createThread、renameThread、archiveThread、unarchiveThread、deleteThread | resource lifecycle；create terminal 可启动程序，archive conversation 可只改变历史可见性，不能同义替换 |
| addQueuedSubmission、listQueuedSubmissions、deleteQueuedSubmission、runQueuedSubmission | optional native queue；有原生队列 ID 才允许变更；Gateway 自己的记录查询不要求该分面 |
| listModels、updateThreadSettings、getAccountRateLimits、getGoal、setGoal、clearGoal | optional native control；参数 schema 和作用范围来自 adapter；原生设置不在 Gateway 写覆盖值 |
| observeThreadInteractions、unobserveThreadInteractions、interactionSubscriptionReady | optional interaction；强身份请求及明确答复回执；terminal blocked 是 attention 观察事件 |
| listSkills、listMcpServers | agent tools；不能从 Herdr 的 integration manifest 推断某个运行 CLI 的工具列表 |
| resumeAfterCapacity、recoverSystemError、systemErrorLifecycleRecovery、findNativeInputReceipts | native recovery；只对 conversation 分面调用，不对 PTY 文本做模拟恢复或文本去重 |
| stageAttachments、fetchOutputFile | filesystem；真实 machine 的授权文件通道。某个 CLI 能否读图是额外能力 |
| withSource、hasInFlightWork、hasRestartBlockingWork、isIndependentObservation、detachIndependentObservations、close | facade/Connector 所有权；来源守卫和短交接门禁保留；关闭观察与停止任务分离 |

迁移以完整类型表核对兼容 facade 的 57 个端口；原 Codex 方法合同保持，新增 runtimeRead/Send/Interrupt/Receipt/Lifecycle 使用独立 schema。

### 8.2 Connector 配置、注册和 typed RPC

1. `peer/index.ts/main`：提取配置解析/装配。旧配置缺 runtime 时走现有 Codex 构造，禁止给旧绑定默认换 Herdr；显式 runtime 只选择一个服务。Herdr 不创建 CodexBackendRouter、Codex rollouts monitor 或读取 Codex 私有主机列表。
2. `peer/registry.ts/descriptionSchema`：新增协商过的 runtime 描述，不把新 id 塞进旧 info 枚举。`peer.register` 继续相同设备认证和三元准入。未支持新执行合同的 Gateway 不接受 Herdr 执行注册，不能退回旧 Codex facade。
3. `peer/contract.ts`：新增具名参数的 runtime 操作表，暴露 runtimeRead/Send/Interrupt/Receipt/Lifecycle；目录与 describe 由注册及既有目录 facade 提供；每项有输入/输出 schema、读写性质、允许的回调类型。禁止 `rpc(method:string,args:any)` 穿透到原生所有接口。
4. `peer/execution-service.ts/attach/execute`：把来源/设备/共享核验、回调寻址和 receipt gate 抽成公共执行边界，再分发到语义分面；不复制第二个同名 Peer 服务。新交接模块的持久记录接入这个边界，先保持与旧 Codex journal 分区，随后有版本迁移；不能同时使用两个账本决定是否重发同一操作。
5. `peer/backend.ts/invoke`：回传 handoff kind，只有 native-accepted 才触发现有 onTurnStarted；terminal-written 触发新的交接回调。对应 callback 都带原操作、来源代次、完整资源身份；过期回调只更新原回执，不更新新绑定卡片。

配置和 journal 的本地 version=1 已实现；这不等于线上 execution v1 已支持 Herdr。已在 `runtime/versions.ts` 以 runtimeContract:1 登记执行合同与能力，混用矩阵及日志身份由统一版本模块管理，避免默默改变 v1 的 thread/turn 字段含义。日志只写组件/制品/合同版本、操作 ID、endpoint、时长、证据种类和安全错误类，不写屏幕或 provider 原始错误。

### 8.3 输入与观察解耦

`BridgeService.runRuntimeInput` 先解析当前绑定的资源类型，持久接收记录，然后由同一权限边界提交。保存交接证据后返回；观察由 `followRuntimeResource(scope,cursor,abortSignal)` 单独负责。后者只有读取/订阅权，接口中不提供 prompt 原文和 send 能力。

`TurnSubmission.run()` 的 Codex 兼容路径保留；`BridgeService.runCodexTurn()` 的准备、投递和卡片创建拆为公共服务，不能把两套 Herdr 嵌入该函数的成功分支。尤其移走“函数返回 → parseActionBlocks → 默认处理完成 → success=true”的通用假设：仅可信 assistant-final 走 action parser，terminal-screen 只能经过文本呈现。

观察信封至少包含 endpoint/resource/incarnation、连接代次、证据来源、观察序号、读取完整性。轮询只对屏幕做替换/去重，不把重绘当新的阶段成果；原生结构化 commentary/tool/final 仍走已有阶段/实时分区。断连显示观察中断；blocked 显示需要人工处理；idle 表示不再观测到 working，均不凭空生成“任务成功”。新观察器不得持有重启阻塞 lease。

`RestartWork` 新 scope 为 native-turn 或 terminal-observation 的联合；交接中无 scope 的短 lease 保留。新增 readonly reconcilers 仅检查记录/状态，不拥有重发输入权限。started=false/null、进程退出、core.turn 增长都不能授权重试。

### 8.4 命令、Web、Taskboard 和文件

操作目录每个子操作记录 targetResolver、effect、所需分面、参数 schema、权限、写前 guard、结果 schema。`/help`、按钮和 typed command 共用；Web/工作流设备边界仍重验。36 个命令/22 个别名及子操作映射见[命令设计](agent-command-compatibility-2026-11-07.md)。目标解析须区分所选目录 Connector、当前绑定、原交互、原交接和原 Issue。

新建/重命名不能简单关闭：TUI 用 workspace/tab/agent.start，App 用明确目标的 space/tab 新建及原生执行模板；不得 `terminal.run` 后又 `space.new argv` 启动两次。布局命名、terminal 标签与原生对话标题分别建模。TUI 中断需要显式 agent 键位契约和效果观察，现已配置式接入；不能解释成“原生没有 stop 所以整个停止能力永久删除”。

`PeerFiles`、`PeerIDEService` 当前依赖 thread/cwd/host；先引入资源到文件主机的解析端口，再复用现有租约、撤权和 code-server 服务。App 的 `machine/t1` 不能在本机打开同名绝对路径，TUI 工作区路径也不是目录授权。上传成功不代表 agent 接受 image input。Taskboard 数据管理不依赖执行分面；workflow/QA 每种节点按实际工具/交互/结构化结果能力校验，不用关闭全部 task 功能代替适配。

### 8.5 状态迁移与上线验收

- 新绑定保存 host、endpoint、resource kind/id 和绑定代次；program incarnation 是写入/观察证据，不能作为永久 conversation ID。旧 thread 绑定迁为 Codex conversation，旧 host 路由不变。
- 新旧记录并存期间以带版本的读写器读取，先备份、校验迁移，再切换写入；旧版本不得把新终端记录当 Codex thread。回退读取旧账本且保留新账本，不覆盖未知交接。
- 线上启用的最低组合：两套 runtime 各完成授权目录→绑定→输入→进度→终态/人工关注→断线续读→文件/IDE；另有撤权/换绑、原生接收与落盘间崩溃、mixed-version 和 Codex 原功能对照。手机展示仍需单列，不能以本次 CLI/PTY 测试代替。
- App 窗口 ls/status 没有 core ID，当前适配靠部署配置钉住 expectedCoreId；必须验证 App 与该 core 的实际连接。后续优先从同一 core 的 herdr-app 文档读取权威目录，窗口只提供界面事实；不能仅靠两个服务都有 t1 就认为配对正确。

## 9. 当前实现边界

已写入源码：两套连接/解析/目录/精确目标/屏幕/输入/中断/生命周期；生产 Connector 配置/注册/typed RPC；公共授权、共享、附件和本机及 App 远端机器完整 IDE；普通 IM/Web 输入与只读观察；全命令目标和能力判定；交接/生命周期日志及原来源只读回执恢复。相同增量测试分别驱动两运行类型，且执行完整 Codex 回归。

卡片根据中断能力显示请求控件；blocked 显示等待终端处理，不生成聊天问答。App 多空间终端不选择第一个项目；目录与 inspect 使用一致的归属要求。丢失 Gateway 回执只查询 Connector 的原来源/目标/指纹；没有回执仍未知，不调用 send。

发布验收边界：源码业务适配已覆盖上述操作；Herdr 缺少强轮次 ID，因此输入参与者分别保留，不猜测合并任务归属。真实钉钉/手机展示和每个底层 agent 的界面行为仍需单独验收。真实 SSH 文件/IDE、两端生命周期/中断和隔离跨组件用例已有证据；2026-11-08 探探及专用测试 Connector 已切换验收构建；完整浏览器操作尚未通过。证据见[生产检查表](../audits/2026-11-07-herdr-adapters/production-checklist.md)。

## 10. 功能登记与正交性合同

每个功能登记目的、所有者、输入/输出、权限、持久状态、异常、兼容迁移、正常/反例 case 和验证缺口。新增功能不得仅出现在代码或聊天里；当前逐项索引见 production-requirements.json。功能、模块说明、接口定义、测试证据需一起更新，不以“文档完成”代替实现。

| 独立维度 | 允许影响的范围 | 必须保持的行为与验证 |
| --- | --- | --- |
| TUI/App 连接方式 | endpoint、握手、帧、公共方法映射 | 不选择用户权限、消息策略或渠道；同一 Peer/授权/回执用例参数化两 adapter |
| 执行器原生能力 | 操作是否存在、输出与确认的语义 | 不因缺模型/审批/队列而禁用目录、文件、准入；原生不可用与未适配分开 |
| actor/chat/account 与角色 | 哪个来源可访问哪个资源 | 不改变 runtime 或借用其他身份；换群、换人、换绑和共享撤权均有反例 |
| host/endpoint/resource/incarnation | 实际目标与观察证据 | 同名目录/项目不形成身份；改变连接不继承旧写入权；读期间目标改变不交付新画面 |
| 文件/IDE 权限 | 当前主机、目录与浏览器授权 | 不从终端程序名扩大文件范围；App 远端机器不能回退本机同名路径；文本共享无终端权限 |
| 输入交接/任务/卡片 | 三者独立状态与责任 | 卡片失败不改变接受事实；等待任务不锁重启；Connector/Gateway 恢复只读证据、不重发 |
| 展示与渠道能力 | 卡片/文字、阶段、动态区、@、复制、IDE | 不支持合并 @ 时只发通知；复制不执行；blocked 不生成审批；终端画面不产生附件动作 |
| 生命周期/清理 | 关闭 Connector 自有连接、租约、锁 | 一个清理失败仍尝试其余；不停止独立 agent；新建/关闭不可冒充聊天归档 |
| Codex 既有功能 | 共享基础模块的兼容调用 | 新 runtime 不覆盖模型设置、原生队列、审批、turn 回执；类型合同及全库回归分别核验 |

这些是需要持续保持的正交边界，不是声称所有组合已经测完。组合覆盖详见逐项证据；不能把某一组合通过外推为任意操作时序、主机断电或所有 agent 版本均已覆盖。
## 持续跟随合同（2026-11-07）

`/follow` 是 Gateway 的只读订阅，不是原生任务队列。Herdr 按 `inspect/read` 能力使用观察协调器；Codex 仍使用原生事件协调器，不能给 Herdr 宣称 native liveFollow 后接入原生 turn 监控。

- 订阅与单条输入回执分别保存。订阅固定 account/chat/actor/binding generation/endpoint/resource/incarnation；重启恢复同一订阅，无 send、interrupt、native resume 调用。
- 初次空闲只记录基线，不发“已完成”卡。观察到运行或阻塞才建立一个展示周期；空闲结束该周期，订阅继续等待后续变化。重启时保持原卡 checkpoint；重复 on/sync 不重建活动卡。
- 输入观察卡优先于同绑定被动跟随卡，避免一份画面发两遍。跟随卡不声称“输入已交接”，更不能将终端空闲当任务成功。
- follow off 只结束被动订阅与它的展示；输入交接恢复及输入结果义务保留。stream off 仅停止过程刷新，仍交付最后结果；恢复展示复用原卡。
- 原来源撤权、换绑、实例变化后停止读屏与退休旧卡；异步读取后再次核对。多群订阅分别授权，不从其他群的订阅继承权限。
- `/follow primary` 只适用于有结构化交互的运行接口；不能修改 Herdr 的原生审批路由。未知卡片投递只允许显式 retry-delivery 重试原实例，不另建新卡。

验收应覆盖：空闲基线→外部启动→空闲→再次启动、重启、重复命令、断线恢复、off 与输入恢复正交、stream 切换、撤权/换绑与读取竞争、原程序替换、卡片未知投递。实际设备和协议替身证据分别记录。

## 生命周期增量：接口合同与实施边界

2026-11-07 续读固定源码：TUI ee5bfb5 的 api/schema/workspaces.rs、tabs.rs、panes.rs、agents.rs、response.rs；App cfcf836 的 control.rs、commands.rs、window.rs。下列是实现约束，不是已交付声明。

| 操作 | 核对到的原生事实 | Bridge 必须保留的边界 |
| --- | --- | --- |
| TUI 新建 | workspace.create 返回 workspace/tab/root_pane；agent.start 另接 name/kind/pane_id/args | 两个外部写入，必须分别保存回执。第二步失败不能再建 workspace；超时未知不重发 start |
| TUI 命名 | agent.rename 接当前 target 和可选 name | 用 terminal_id 重新定位 pane，核对实例；不能把 tab.rename 当单个 agent 命名 |
| TUI 关闭 | pane.close 与 workspace.close 是不同范围 | 资源关闭不能扩大为关闭整个 workspace；不等于归档聊天 |
| App 新建 | 窗口 JSONL 的 do/args 经 control→run_as→new_space/new_tab；窗口默认参数可依赖当前焦点 | 必须显式传空间、目录、机器与 agent 选择，不能依赖用户正在看的 pane；不能同时调用 terminal.run 再 space.new 造成两份终端 |
| App 命名 | tab.rename 改的是布局 tab 名称 | 一个 tab 可以包含多个 pane；不能声明等价于单终端命名 |
| App 关闭 | pane.close 在最后 pane 时递归 tab.close；最后 tab 再递归 space.close；脚本关闭 space 要 confirmed=true | 必须核对受影响对象，选择最小范围；不得用无条件 confirmed 绕过原操作范围，也不能把这个行为藏在 /unbind 或 /archive 中 |

本轮已把资源创建、命名、关闭与 Gateway 目录元数据 CRUD 分开，定义 typed lifecycle intent/receipt，沿用原 actor/chat/grant 和写前守卫。创建授权不能靠尚未存在的 threadId 伪造；必须以已授权的项目/目录及启动项为范围。窗口响应丢失后只读核对原资源，缺乏可证明关联时报告未知，不能按相似标题猜测后重放。

### 本轮实施合同（先登记，验证后更新状态）

- `RuntimeLifecycleAction` 区分 create / rename / close；不复用 archive/deleteThread。create 明确目录、程序及 argv 参数，不能继承窗口焦点、默认模型或 Gateway 的旧设置。TUI 的 program 是原生 agent kind；App 的 program 是显式可执行程序名，不把 core 模板名传入 App 的 shell 启动器。
- Connector 保存 version=1 生命周期账本：来源、操作指纹、writing/confirmed/partial/not-sent/unknown、已创建资源及结果。TUI 每一步之后先落盘再做下一步；进程重启不重复创建或补发启动。相同来源的任何阶段都只返回原记录，不作为执行队列。
- 新建仅限完整设备授权；固定资源和委托授权不能借新建扩大权限。已有资源操作须匹配 endpoint/resource/incarnation 和当前 actor/chat；每个外部写入前重新验证聊天与设备准入。
- App rename 的等价边界是只有一个终端的 tab 名称；多终端 tab 拒绝资源重命名，不能影响旁边终端。App close 使用 core terminal.kill，只结束指定终端进程，不调用布局删除；App 可能按原生规则自动清理结束的终端及空空间。TUI close 只关闭该 terminal 当前所在 pane。两者均明确显示范围，永不冒充聊天归档。
- 部分创建保留已确认的资源标识，即使 agent 启动失败也可在目录中核对；不能清理未知终端、按标题猜测归属或静默回滚。
- 用例必须包含两端正向创建/命名/关闭、第二步失败、落盘失败、换绑/撤权、断连未知、重复来源、重启读取、错误回执、不同来源竞争、Codex 既有管理不变。上述生命周期已实现；测试与真实两端验证分别见检查清单，未知创建仍不能自动重放。

### 命令、工作目录与展示的独立合同

- 36 个规范命令由同一命令注册表保留别名；操作目标另由完整类型表声明为 Gateway、目录选择、当前绑定或原记录。`/new` 跟随目录选择，模型/停止/命名跟随绑定，审批/答案和已有队列回执跟随原记录；切换 Connector 不能改变原请求的执行器。
- Taskboard 数据 CRUD 属于看板；发送工作说明属普通输入，复用运行接口。终端屏幕不能直接宣布 Issue 已验收或执行模型输出中的动作。需要动态检索工具的 QA 仍明确要求原生结构化工具协议，不以 PTY 按键伪装。
- 没有 cwd 的终端仍可绑定、读取和观察。ManagedSession 用 `workspaceState: unknown` 与空 workspace 表示未知，不使用进程 cwd、根目录或本机同名目录代替。它不形成项目或文件授权；获得新 cwd 后按真实目录重新建立边界。
- 所有终端写入在异步来源核验之后再次读取实例、目录、机器及面板位置。公共接口没有原子实例 CAS 时如实保留观察式保护的限制，不能声称排除最后一次读取之后的外部替换。
- 输入、中断、命名和关闭共用短交接锁；不同资源独立。锁只覆盖外部写入与回执，不覆盖远端执行期，不构成重启门禁。
- 卡片 checkpoint 的嵌套 bootstrap、phase、分页和 segment 都需验证；不可将未知字段直接透传为投递状态。渠道投递成功、终端空闲和用户任务完成是不同事实。

### Web 管理入口与终端输入

Web 会话页从同一资源描述读取能力；模型/推理设置属于原生设置能力，流式展示属于 Gateway，二者互不牵连。终端资源的历史区展示经过转义的快照，不执行其中的动作块。Web 输入复用 IM 的持久化交接与只读观察器，返回“交接确认”而非“任务完成”。Web 管理身份仅可写部署配置中显式托管的 Connector，不能借用个人 Connector 的群授权；恢复观察保留该来源并重新检查托管路由和绑定代次。普通 IM actor 即使名称为 web-admin，也不取得这个身份。

### 文件主机、IDE 与文本共享的统一端口

`RuntimeFilesystem` 是资源到文件主机的唯一解析入口；上传、下载、共享编辑与完整 IDE 复用该结果。App 远端资源依据已钉住 core 的 `machine.list`，使用原生机器配置的 SSH 或 via 连接，不能从 cwd、显示名或 Codex SSH 配置猜测主机。远端缺少文件通道时明确失败，不访问本机同名目录。

`ScriptHost` 提供固定 helper 的启动参数和只读 `verify`。host id 包含 endpoint、机器身份、连接配置及资源的项目/目录范围；同机不同资源不能覆盖彼此的校验器。文件范围与前台程序、任务状态、屏幕独立：同目录切换程序不撤销文件授权，换机器、项目或目录会失效。文件传输结束再次验证原范围和当前来源；失败的下载租约立即清理。

IDE 使用同一主机端口运行目录核验、code-server 查找/安装和启动。远端 UNIX socket 通过受控 helper 的原始 stdio 中继，保留 HTTP upgrade、WebSocket、二进制和半关闭语义，不经过终端屏幕。每个新连接再次验证主机；关闭 Connector 只关闭其 code-server 租约和中继进程，不结束 agent。文本共享仍只有文本文件权限，不因接入同一文件主机获得 IDE 终端。

验收组合：两资源同机隔离、程序变化与目录变化的正交性、机器配置被替换、撤权、上传/下载完整性、共享乐观写入、IDE HTTP/WebSocket 大块传输、读写期间换绑及清理幂等。协议替身和真实 SSH 的证据分别登记，不能互相替代。

### TUI 配置式中断

TUI 公共 `pane.send_keys` 只确认按键投递，不提供跨 agent 的中断语义。Connector 的 version 1 TUI 配置增加可选 `interruptKeys`：精确 agent 名映射到单个 `esc` 或 `ctrl+c`。不默认推断、不允许通配、任意文本或连续按键。配置变化改变 endpoint 身份，旧目标不能静默继承新中断策略。

中断只对已确认 working 的同一实例、目录和 pane 发送一次；写前重新检查来源及目标。idle/done 返回未运行；blocked/unknown 不发送。原生 ok 后重新观察，分别报告 stopped/still_working/unknown，观察失败仍保留已确认投递事实。沿用 Peer 中断回执和短交接锁，不重放未知请求，不把此接口用作审批答案。缺配置标记 configuration-required，区别于未实现和原生无此能力。


### 文件租约与真实容器运行边界

`PeerFiles` 在开始传输时保存 runtime 的文件范围戳（endpoint/resource/project/cwd/machine），主机解析、上传发布及下载每个分块重新核对；变化即终止旧租约，不让同路径继承另一项目的数据。Codex 原文件协议未增加虚构的 runtime 身份。机器连接配置的改变还会使 ScriptHost 身份失效。

App 远端 Node 可能由容器 wrapper 启动：登录 shell 的 HOME 以 argv 传入固定 helper，修正 wrapper 的 HOME=/；不会修改全局环境。远端 IDE socket 放在所属账号的私有持久目录，等实际 socket 就绪后才回报地址，避免每次调用独立容器 /tmp 无法互通。SSH/via 的 Node、code-server 和持久 home 需在目标主机可用；默认 SSH 使用已有 key/agent 和严格主机校验，不复用 core 内部的交互密码登录。

### Taskboard 节点边界

目录、AI 面板创建/提交/设置、工作流原生节点准备共用 structured-output 能力含义。MCP/Skill 节点在原生目录查询前返回相同的能力说明。确定性看板 CRUD、条件/数据节点不受影响；IM 工作说明走普通终端输入。终端 idle 不能推进依赖原生最终结果的后续节点，不能自动标记 Issue 完成。
