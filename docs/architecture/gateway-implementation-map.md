# 功能契约对应的实现边界（本轮复核记录）

原生配置与设备自助登记增量：IDE-08.4、PEER-01.4，见[本次四层检查及命名用例](../audits/2026-11-04-native-config-enrollment/README.md)。旧汇总数字是对应历史检查点，不能代替增量证据。

配套文件：gateway-contracts.md 记录历史要求；gateway-requirements.json 记录每个场景及证据；本文件定位实际入口和状态写入者。下列是实现关系，不是“已经检查通过”的清单。关键函数的输入、状态义务和异步边界另记 function-contracts.jsonl，仅包含已有明确逐函数记录的部分，不以全文件读过冒充全部函数行为均已验证。逐行范围、内容散列、未读文件在本轮 read-ledger.jsonl 和只读报告中单独保留。

## 主链路

当前 Connector 负责到执行主机的连接与传输；Gateway 的来源、角色、绑定和投递职责共用。以下原生轮次链路描述 Codex 分支；Herdr App/TUI 的终端输入走同一 Bridge 入口后的运行适配器、RuntimeObservationController 和独立交接回执，不能套用 Codex turn/queue 或通过终端按键模拟审批。详见[运行接口模块](modules/agent-runtime.md)。

平台事件 → AccountManager 账号运行代次与接收持久化 → ForwardingInbox 来源交接 → BridgeService 显式命令或普通输入 → TurnSubmission/SessionControl/NativeQueue → CodexAppServerGateway 主机路由 → AppServerCodexRunner 原生协议。

原生接收回执恢复：原host/thread历史分页 → 精确clientUserMessageId → 来源journal CAS accepted与投递义务 → Hub排除误判历史baseline → 结果动作与原路投递 → 持久确认后结算。没有新的执行入口。

原生通知/观察 → AppServerRequestMonitor 与 ThreadEventHub → 精确绑定和 InteractionRouting → 原路审批/提问或 TurnPresentation → 渠道业务回执 → 投递状态持久化。原生执行事实、平台接收事实、客户端可见事实分别记录。

Web IDE 走独立链路：当前原生项目归属 → WorkspaceIDEManager 项目身份和完整根目录 → EndpointManager/Provider 主机实例 → ApprovalService 与 Authorization 原浏览器证明 → AccessServer HTTP/WS 访问。它不通过 Codex 任务启动或保活。

## 模块定位与检查重点

| 模块 | 实际入口及实现 | 状态权威与必须检查的边界 |
| --- | --- | --- |
| 原生协议 | src/codex/app-server-gateway.ts、app-server-runner.ts、app-server-daemon.ts、remote-host.ts | 每主机固定核心；执行、元数据、历史连接的权限和生命周期；精确回执；既有线程继承权限；不能因超时改执行器或重发 |
| 接收交接 | src/server/account-manager.ts；src/bridge/forwarding-inbox.ts、inbound-receipts.ts、turn-submission.ts、native-input-recovery.ts | 来源与附件先保存；提交、已接收、未知、已处理分离；交接串行与运行等待分离；崩溃恢复不能重放未知输入 |
| 持久状态 | src/state/runtime-state.ts、json-store.ts、paths.ts、config.ts | 账号/会话/主机身份和版本；写前校验、原子保存、落盘失败后的内存一致性；旧格式迁移不扩大权限 |
| 绑定和主入口 | src/bridge/session-execution.ts、session-follow.ts、interaction-routing.ts；AccountManager 订阅协调 | 精确 account/chat/host/thread 与运行代次；主入口不是模糊目录匹配；旧异步结果、换绑、解绑和 ABA 变化 |
| 目录/项目/历史 | src/codex/desktop-session-catalog.ts、desktop-session-membership.ts、history-reader.ts；src/bridge/session-catalog-order.ts、project-selection.ts | 完整普通会话目录；项目 assigned/none/unknown 与 cwd 区分；原生 ID/别名/完整根；公开历史与重型读取隔离 |
| 控制编排 | src/bridge/service.ts、channel-commands.ts、session-control.ts、native-queue.ts、new-session.ts | 仅显式控制；默认 steer、显式原生 queue；来源末次复核；原生接收、队首、取消和已结束恢复不冒充新执行 |
| 准入/角色 | src/bridge/access.ts、admission.ts；src/channels/principal.ts | 操作者/群/账号不同身份；控制者、参与者、只读访问；个人准入与 IDE 配对；撤销后的旧控件 |
| 交互 | src/codex/approval.ts、user-input.ts、elicitation.ts、native-async-questions.ts；src/bridge/approval.ts、user-input-controller.ts | 原请求/选项/范围、原路投递；部分答案与兄弟题；提交和原生确认；路线缺失不能代答；超时拒绝仅属已接管本地审批的既定策略 |
| 恢复 | src/server/capacity-recovery.ts、system-error-recovery.ts；原生 runner 状态重载 | 容量恢复与 systemError 分开；精确失败轮；原生队列/用户输入优先；无提示重发；archive 补偿义务持久化；只读恢复不能伪造新开始 |
| 进展和结果 | src/server/thread-event-hub.ts；src/channels/turn-presentation.ts、progress.ts、turn-progress-card.ts、result-pages.ts、assistant-presentation.ts | 按轮、阶段、页和卡片实例持久化；流式/终态/加载/停止/复制/IDE 页脚一致；无关历史不补发成新卡；精确恢复义务可补发离线结果，客户端展示另验 |
| 渠道和网络 | src/channels/dingtalk.ts、feishu.ts、wecom.ts、weixin.ts、client.ts、network-request.ts、network-family.ts | 平台身份、业务回执、附件下载和大小/总时限；IPv4/IPv6 有界重试；卡片未知不能另发文本；微信游标按成功处理范围提交 |
| IDE | src/ide/manager.ts、project-identity.ts、workspace-scope.ts、endpoint-manager.ts、approval-service.ts、authorization.ts、access-server.ts、installer.ts、tls.ts、remote-ingress.ts | 项目所在主机；完整多根私有 workspace；固定入口与 90 天授权；HTTP/WS 新鲜归属；撤销不可复活；安装/证书/进程独立 |
| Web UI | src/server/http-server.ts；src/web/ 页面/脚本/样式；src/ide/copy-controls.ts | 保存事实与编辑状态分离；迟到回执只更新原页面/原目标；可选服务不挡主页面；复制不等于提交；静态引用和可访问性 |
| Taskboard | src/taskboard/；src/bridge/taskboard-channel-*；taskboard/server、web、shared、cloud、cli | 可选嵌入、独立/远端模式；不按同路径猜跨主机身份；表单真实保存；任务板数据不等于原生任务；子包独立检查不能被根测试替代 |
| 知识/QA | src/state/knowledge.ts；src/knowledge/llm-wiki-mcp-client.ts；src/bridge/turn-result-actions.ts | 主机、真实路径、软链接和稳定条目 ID；初始化合并与 MCP 生命周期；QA 动态工具的进程所有权不同于独立原生观察 |
| 构建/重启 | src/server/restart.ts、restart-helper.ts、release-admission.ts、update-manager.ts；scripts/ 发布安装脚本 | 先准备隔离制品；只保护 Gateway 活跃交接；已独立接收的任务不锁重启；未知保留不重发；当前运行制品与 push 状态分别验收 |
| 审查证据 | docs/architecture/；docs/audits/2026-11-01-four-layer-recheck/；scripts/check-audit-evidence.mjs、audit-test-reporter.mjs | 历史来源→职责→文件行→具体反例/对照→修复/证据；缺测/未读/客户端未验明确保留；检查工具不参与运行和发布门禁 |

## 当前架构待核对项

- Gateway 原生 facade 的整轮 runTails、底层 waitForThreadIdle，以及随后复现的 Bridge 主入口整轮队列已分别移除。只保护接收前交接；已接收的独立轮次不因等待执行结果阻止重启。源码修改和已跑窄场景不替代真实重启验收。
- 显式消息合并由账号本地 prompt-buffers.json 保存正文/附件引用，按 collecting/preparing/submitting 分离；Gateway 的转发 inbox/原生回执仍分别记录来源和接收。尝试后未知不因重新发送 done 或重启而重放。
- CapacityRecovery checking/settling 与 SystemErrorRecovery pending 已按实际反例拆开只读等待与交接。实际原生RPC由transport保护；渠道文本/卡片/媒体每次写入独立持lease。stop退休journal writer，补偿义务仍持久保存，见恢复模块说明。
- Taskboard AI、自动处理器及额度现已复用同一原生适配器；嵌入服务借用根实例，独立包默认 daemon。旧 Cron 管理和窗口嵌入属于 Desktop UI 集成，不是另一执行器；标准原生 schema 没有 scheduler 管理方法，未编造该 API。详见 taskboard-native-execution 模块。
- 原生不同项目 ID 不再按 cwd 合并；已知旧别名按当前 host/home 映射或完整根集合解析，未知明确 ID 拒绝替换，新建携带全部根。新绑定 unknown 不伪造 none；原 IDE grant/管理身份未改写。
- Taskboard IM表单经taskboard-submissions.json与SQLite/D1事务回执处理跨重启未知写（TB-09.5）；浏览器部分附件由独立提交记录处理（TB-03.4、TB-09.1/.2/.4）。Codex workflow交接未知与真实骤停另列TB-09.6，不能继续写成“仅内存去重未解决”。原生idle队列历史一次观察失败仍未查明。
- 历史引用97个不同图片路径中，92张仍存在且已逐张打开，5张早期临时图丢失；本轮实际 Chrome 组件测试不替代钉钉/微信/手机真实客户端验收。

## 当前验证边界与历史记录

2026-11-08 按需求记录汇总：459case 全部有测试映射，364 项仅在列明边界通过、95 项部分覆盖。统计同步不更新历史测试的新鲜度或提升旧状态；具体边界以 gateway-requirements.json 为准。历史 13 项说明校准未因此新增运行证据或升级状态。

[当前剩余清单](remaining-work.md)给出未实现、缺测与实机验收；[文档校准记录](../audits/2026-11-01-four-layer-recheck/2026-11-02-documentation-reconciliation.md)记录具体差异；首次阅读计数和旧失败保留于历史审计报告，不再当作当前结果。原检查点按行记录与140份精选函数合同不能证明全部模块行为或真实设备已验收。

## 2026-11-08 修复的实现映射

| 合同 | 实现及调用关系 | 必须保留的边界 |
| --- | --- | --- |
| IN-01.slash-forwarding | channel-commands 的 parseCommand / mayBeChannelCommand / classifyChannelInput → BridgeService 控制或普通输入 → 原交接流程 | 注册决定控制语义，授权另行检查；原文、附件和引用不改写，未知回执不重发 |
| CTRL-05.runtime-help | runtime-help 的 entries / runtimeHelp → 同一注册表及 runtime-command-policy | 全量/主题/别名/扩展一致；参数错误或能力缺失不变成终端输入 |
| IDE-14.webview-timeout | ide/link-entry 的页面脚本 → AccessServer 同源交换 → 原 workspace 路径 | 单次在途请求、定时器清理、过期手动取新证明；Origin、授权和项目范围不放宽 |
| STATE-01.stage-dedup | ThreadEventHub 加载/归档/旧结果及迟到回执 → follow-checkpoint-compaction → 原同步原子保存 | 只删除当前已持有的完全相同阶段副本；不同回执、唯一副本、最终结果和附件动作保持 |
| IDE-03.health-retry | RemoteIDEIngress.run → 自有 SSH connection 与独立 HTTPS probe | 连续三次失败才重建，成功清计数及 error；真实退出和取消仍清理，不影响 agent 任务 |

本次登记十项精选函数的实际范围及散列；不批量更新其他历史函数散列，未重新核验的旧记录仍是原版本证据。[同步记录](../audits/2026-11-08-documentation-reconciliation.md)列出测试与验证边界。

## Connector 增量映射（2026-11-03）

| 入口/责任 | 实现 | 对应契约 |
| --- | --- | --- |
| 可选listener、设备主动dial、固定profile与凭据、配对 | peer/runtime、transport、gateway-trust、registry、index；server/index与arguments | PEER-01、PEER-02 |
| 完整后端装饰器、DTO、回调、错误与版本 | peer/backend、execution-service、contract、interaction-client/service | PEER-01、PEER-02.2 |
| 末次来源核验、原生队列来源与补偿 | codex/write-guard、peer/write-guard、receipts、recovery-journal；原NativeQueue与AccountManager | PEER-03 |
| 原session管理、附件、所有者与共享浏览器入口 | peer/management、files、sharing-*、workspace-* | PEER-02、PEER-04 |

非peer路径直接委托原facade。新端口没有新的业务调度器；渠道卡片、复制、审批和结果投递继续由原模块处理。`peer/channel`是可组合Channel适配器，未增加第二套渠道业务处理，也没有自动启用远端Channel入口。

[当前增量验收](../audits/2026-11-03-peer-contract-review/merge-completion.md)单列本地、真实SSH、真实Codex及协议夹具；原main的partial和真实设备待办不因Connector回归被升级。

2026-11-04 增量：REL-02.11 的 HTTP 收尾及 GitLens 实际验证见 [验证收尾记录](../audits/2026-11-04-verification-boundaries/README.md)。历史总数不作为本次测试总数。
