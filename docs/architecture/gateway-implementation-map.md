# 功能契约对应的实现边界（复核中）

配套文件：gateway-contracts.md 记录历史要求；gateway-requirements.json 记录每个场景及证据；本文件定位实际入口和状态写入者。下列是实现关系，不是“已经检查通过”的清单。关键函数的输入、状态义务和异步边界另记 function-contracts.jsonl，仅包含已有明确逐函数记录的部分，不以全文件读过冒充全部函数行为均已验证。逐行范围、内容散列、未读文件在本轮 read-ledger.jsonl 和只读报告中单独保留。

## 主链路

平台事件 → AccountManager 账号运行代次与接收持久化 → ForwardingInbox 来源交接 → BridgeService 显式命令或普通输入 → TurnSubmission/SessionControl/NativeQueue → CodexAppServerGateway 主机路由 → AppServerCodexRunner 原生协议。

原生通知/观察 → AppServerRequestMonitor 与 ThreadEventHub → 精确绑定和 InteractionRouting → 原路审批/提问或 TurnPresentation → 渠道业务回执 → 投递状态持久化。原生执行事实、平台接收事实、客户端可见事实分别记录。

Web IDE 走独立链路：当前原生项目归属 → WorkspaceIDEManager 项目身份和完整根目录 → EndpointManager/Provider 主机实例 → ApprovalService 与 Authorization 原浏览器证明 → AccessServer HTTP/WS 访问。它不通过 Codex 任务启动或保活。

## 模块定位与检查重点

| 模块 | 实际入口及实现 | 状态权威与必须检查的边界 |
| --- | --- | --- |
| 原生协议 | src/codex/app-server-gateway.ts、app-server-runner.ts、app-server-daemon.ts、remote-host.ts | 每主机固定核心；执行、元数据、历史连接的权限和生命周期；精确回执；既有线程继承权限；不能因超时改执行器或重发 |
| 接收交接 | src/server/account-manager.ts；src/bridge/forwarding-inbox.ts、inbound-receipts.ts、turn-submission.ts | 来源与附件先保存；提交、已接收、未知、已处理分离；交接串行与运行等待分离；崩溃恢复不能重放未知输入 |
| 持久状态 | src/state/runtime-state.ts、json-store.ts、paths.ts、config.ts | 账号/会话/主机身份和版本；写前校验、原子保存、落盘失败后的内存一致性；旧格式迁移不扩大权限 |
| 绑定和主入口 | src/bridge/session-execution.ts、session-follow.ts、interaction-routing.ts；AccountManager 订阅协调 | 精确 account/chat/host/thread 与运行代次；主入口不是模糊目录匹配；旧异步结果、换绑、解绑和 ABA 变化 |
| 目录/项目/历史 | src/codex/desktop-session-catalog.ts、desktop-session-membership.ts、history-reader.ts；src/bridge/session-catalog-order.ts、project-selection.ts | 完整普通会话目录；项目 assigned/none/unknown 与 cwd 区分；原生 ID/别名/完整根；公开历史与重型读取隔离 |
| 控制编排 | src/bridge/service.ts、channel-commands.ts、session-control.ts、native-queue.ts、new-session.ts | 仅显式控制；默认 steer、显式原生 queue；来源末次复核；原生接收、队首、取消和已结束恢复不冒充新执行 |
| 准入/角色 | src/bridge/access.ts、admission.ts；src/channels/principal.ts | 操作者/群/账号不同身份；控制者、参与者、只读访问；个人准入与 IDE 配对；撤销后的旧控件 |
| 交互 | src/codex/approval.ts、user-input.ts、elicitation.ts、native-async-questions.ts；src/bridge/approval.ts、user-input-controller.ts | 原请求/选项/范围、原路投递；部分答案与兄弟题；提交和原生确认；路线缺失不能代答；超时拒绝仅属已接管本地审批的既定策略 |
| 恢复 | src/server/capacity-recovery.ts、system-error-recovery.ts；原生 runner 状态重载 | 容量恢复与 systemError 分开；精确失败轮；原生队列/用户输入优先；无提示重发；archive 补偿义务持久化；只读恢复不能伪造新开始 |
| 进展和结果 | src/server/thread-event-hub.ts；src/channels/turn-presentation.ts、progress.ts、turn-progress-card.ts、result-pages.ts、assistant-presentation.ts | 按轮、阶段、页和卡片实例持久化；流式/终态/加载/停止/复制/IDE 页脚一致；历史不补发成新卡；客户端展示另验 |
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
- CapacityRecovery 的 checking/settling 与 SystemErrorRecovery 的 pending 仍按较大操作范围保护重启。只读等待、实际原生修改、落盘和结果投递需要逐路径区分，不能依据函数名直接删除保护。
- Taskboard 自身 AI 面板使用独立 CLI exec；Gateway 的任务板渠道命令使用统一 App Server。前者是当前仓库中另一条真实执行链，不能因为它位于子包就宣称“全部代码已经统一接口”。是否应纳入统一迁移，须结合所有独立/嵌入入口继续核对；目前未宣称适配完成。
- 新建项目别名解析仍按部分 cwd 匹配，完整 rootPaths、迁移身份及同目录多项目的边界仍需验证。
- Taskboard 渠道等待后来源漏洞已有六个原版反例并本地修复21场景；未知写入结果、仅内存去重和部分上传仍未解决。原生 idle 队列一次偶发观察失败尚未查明。
- 历史引用97个不同图片路径中，92张仍存在且已逐张打开，5张早期临时图丢失；本轮实际 Chrome 组件测试不替代钉钉/微信/手机真实客户端验收。

## 本轮阅读与验证结论

基线663个文本文件已逐行阅读，25个非源码制品另按视觉/结构检查，未读0。239个场景有精确测试映射，142个仅限注明边界通过；96个部分覆盖、1个场景有2项失败、39个缺直接断言。详见本轮review-conclusions.md及gateway-case-coverage.md。
