# 多 agent 运行接口

状态：Herdr TUI / App 的资源目录、生命周期、输入交接、观察、文件/共享/完整 IDE、IM/Web 与 Taskboard 能力边界已接入源码。尚未 npm 发布；线上版本以 [部署证据](../../audits/2026-11-07-herdr-adapters/deployment-verification.json) 为准。模块/函数方案见 [Herdr 设计](../herdr-adaptation-design.md)，命令目标见 [命令合同](../agent-command-compatibility-2026-11-07.md)，检查范围见 [四层检查](../../audits/2026-11-07-herdr-adapters/README.md)。

## 命令与帮助入口

IN-01.slash-forwarding：`classifyChannelInput` 按内置及扩展注册清单分流，`parseCommand` 保持纯语法职责。未知斜杠先提示，再走原有普通输入流程；路径、引用及正文不误当控制。共享权限、聊天角色、忙碌状态和回执去重仍独立生效；旧卡片回调不能变成输入。

CTRL-05.runtime-help：`runtimeHelp` 使用全部命令登记、别名、同一能力拒绝策略及 Taskboard 状态，支持分项和单命令说明。`handleRuntimeCommand` 将帮助主题和扩展清单传入展示层，不另行维护执行逻辑。`buildPromptParts` 保留正文首尾空白与换行；格式化预览和命令语法解析不得改写实际输入。功能及检查矩阵见 [斜杠输入与终端帮助](../slash-routing-and-runtime-help.md)。

## 职责

`src/agents` 把服务事实归一化为资源、能力、屏幕、交接证据；没有聊天、群、卡片或 code-server 依赖。Gateway 仍拥有绑定、个人准入、共享、展示与投递；Connector 仍为唯一设备入口。`peer/config.ts` 现在接受显式 `herdr-tui` / `herdr-app` 配置；旧配置仍默认 Codex，混用 Codex profile、binary、transport 或主机导出会被拒绝。配置只选择连接，不启动另一套服务。

Herdr TUI 适配其公共 JSONL API。Herdr App 适配正在使用的 core 执行接口及 App 空间目录；core 是 App 的依赖，不单独增加第三种产品入口。未来 agent 接入按协议/能力分面，不在频道中增加 agent 品牌分支。

## 当前函数与状态所有者

| 入口 | 职责 | 异常/恢复规则 |
| --- | --- | --- |
| config.createHerdrRuntime | 严格 version/kind、绝对连接地址、App 核心 ID；配置变化生成新的 endpoint 身份 | 无 fallback，不启动服务，不改现有配置 |
| JsonLineClient.request | 每请求 ID、帧大小与 UTF-8、超时、通知分离、连接后写前同步核验 | 已进入 socket.write 后失败为 unknown；绝不重发原请求 |
| adapter.catalog / inspect | workspace/space 与稳定终端 ID；cwd、machine、实例与状态证据 | 空项目保留，离线不冒充空目录，同名不作为身份 |
| adapter.read | 屏幕来源和截断标识；读取前后目标复核 | 没有身份可读，但目标改变丢弃输出；不是 assistant final |
| adapter.send | 原生 prompt/send、当前实例、就绪状态、最后来源守卫 | blocked 拒绝普通输入；不退回键盘/force；不伪造原生轮次 |
| adapter.interrupt | App 原生 interrupt；TUI 为精确 agent 显式配置单个中断键 | 仅对已核验 working 实例；仍工作/未知不称停止；blocked 不发键 |
| RuntimeHandoffCoordinator.sendOnce | 来源/输入指纹、持久意图、同终端短交接互斥、确认回执 | 重启 writing→unknown；重复来源返回旧结果；不运行任务队列 |
| close | 关闭自己持有的 socket 和待定请求 | 不终止 agent；App 窗口目录请求也能取消 |

Journal 使用独立 version=1 文件，必须在所属 Connector 的进程锁范围内使用。`PeerRuntimeService` 对 send 只使用 RuntimeHandoffJournal，不再叠加旧原生回执流程；interrupt 使用独立 PeerReceipts 文件和终端级短互斥。Gateway 的 InboundReceipt 仅记录来源及 runtimeInput 标记，原生历史恢复明确排除该标记。Gateway 的观察 journal 不含 prompt，也不是执行队列。

App 的 `idle` 和 `done` 都可接收下一轮，不能把完成后停留在 `done` 的 Codex 拒之门外。两者均要求已观察到 agent 身份，并在最后写入前再次读取和校验实例及就绪状态。core 的公共 `only_if` 仅接受 idle/working：idle 继续传原生条件，done 省略该字段，始终保留 `force=false` 的原生 blocked 防护。没有原生 done CAS 时仍存在末次读取后的状态变化窗口；不能声称新增了原子条件或通过模拟按键绕过交互。

### 只读交接恢复

Gateway 在输入交接前保存原来源 ID 和输入指纹；Connector 提供独立的只读回执查询。查询按当前已授权的原 actor/chat/account 生成原 send 操作身份，核对 endpoint、资源及指纹；不调用 send，不要求重新提供 prompt，不因查不到回执而判定未发送。确认回执可修复 Gateway 来源记录和原卡片的交接状态；未知仍未知。旧观察记录缺少来源指纹时只继续观察，不猜测匹配。

隔离验收覆盖：Connector 已确认但 Gateway 丢失响应、双方重建、不同用户/群/资源拒绝、未知/不存在回执零写入、伪造或格式错误响应不升级为确认。Gateway 来源记录先恢复，写盘失败不提前结算观察义务。证据见 agent-peer、runtime-channel、runtime-observation 和 inbound-receipts 测试；不是线上骤停验收。

## 生产调用链与新增边界

| 模块/函数 | 责任及核验 |
| --- | --- |
| RuntimeResourceCatalog / resourceBindingId | 提供既有目录需要的元数据投影；endpoint-qualified ID 不依赖内存映射；没有 run 或伪造 turn |
| PeerRuntimeService.call | 复用配对、共享和精确来源回调；socket 连接完成后再次异步询问来源，再同步核对设备授权；重复来源不重放 |
| BridgeService.runRuntimeInput | 复用角色、绑定代次和附件转存，保存来源/观察意图，再交接输入；交接完成后释放短锁，不等待终端任务 |
| handleRuntimeCommand / runtimeCommandRestriction | 按声明的操作语义路由状态、终端画面和中断；区分未适配和无等价原生操作；不能把模型/审批命令打入终端 |
| RuntimeObservationController | 只读重连；按原 actor/chat/bindingStamp 恢复权限；读取后再次检查旧目标，换程序不泄漏新画面；不调用 send/stop |
| ChannelTurnPresentation | 保留阶段记录、有限实时区域、IDE footer、复制行为；终端 idle/error/exited 是观察结果，不生成任务成功回执；阻塞状态在画面刷新后应用 |
| RuntimeObservationJournal | 原卡片 checkpoint 及 @ 尝试留证；未知卡片不另建替代卡；@ 无供应商幂等回执时不自动重发 |
| runtimeReceipt / recoverRuntimeAccepted | 从当前 grant 派生原 send 身份，核对目标/指纹；只更新原来源事实，无 prompt 或原生 turn |
| closeConnectorResources | 顺序尝试自有 transport/readline/IDE/host/backend/lock；单个失败不能跳过其余，汇总错误；不停止独立 agent |
| RuntimeFilesystem / ScriptHost | 按资源项目、目录、机器解析唯一文件主机；App machine.list 的 SSH/via 连接；不借用本机同名路径；每次传输、IDE 租约、共享写入重验范围 |
| SharedWorkspaceHost / PeerIDEService / PeerFiles | 复用同一主机执行固定 helper、文件租约、code-server 与原始 socket 中继；文件范围独立于前台程序；文本共享不获得终端权限 |

断连时 backendInfo 保留最后已认证的 runtime 描述；从未连接的托管入口报告未知，不能默认宣称 Codex 全能力。入口握手也在清理边界内，失败关闭自身 socket 并释放锁。

多空间或机器归属不一致的 App 终端不获得项目绑定；列表报告不完整，详情拒绝含糊归属。blocked 显示“等待终端处理”；不支持 interrupt 时隐藏停止控件，支持时仅呈现请求中断，未确认状态不提供该控件。屏幕快照不是结构化阶段成果；只保留已观察状态事件和有界画面，不声称提取了 agent 全部 commentary。

## 持续跟随和输入观察正交

`RuntimeObservationController.follow` 保存只读订阅；普通 `begin` 保存单条输入对应的观察义务。旧 version 1 行没有 following 字段，仍按输入观察恢复，不迁成自动订阅。订阅不含 prompt，也不具有发送或恢复执行的权限。

`tick/synchronize` 先检查被动订阅，再处理输入观察，保证本轮快结束的输入不会因为回执移除而再次触发被动结果卡。`observeNow` 在空闲时保存基线；看到运行/阻塞或新状态序号后才打开展示周期。`resetFollow` 只在原卡投递已确认后清理周期，保留订阅；不清掉未知创建证据。输入卡接管展示时沿用同一授权绑定，不跨群合并。

`/follow on/off/sync` 调用此只读协调器；`primary` 不会误改 Codex 的审批路由。`sync --retry-delivery` 对进行中和终态两种原卡都适用，只有控制者明确发出完整命令才传递允许重试标志。未知原生文本发送无幂等身份，仍不自动重发。

`refreshRuntimeBinding` 在绑定/stream/follow 变更后刷新对应观察，保留 checkpoint 并停掉旧计时器。stream off 期间不刷新过程；最后结果仍按原投递方式送达。follow off 只删除被动订阅，单条输入的回执恢复及最终结果不因此丢失。Gateway 进程退出只 suspend，下一实例继续原卡。

2026-11-08 真实 TUI 发现同一 tick 内被动读取先看到 working，输入读取后看到 idle/新序号，输入卡结算后下一 tick 把同一序号当作外部任务，再发结果卡。finish 现在在删除输入观察义务前，等待同绑定被动观察结束，将本次已核验的状态/序号写入其空闲基线；保留更晚的基线、不同目标、活动/未知投递卡以及原订阅身份。重启前后反例均覆盖，真正更晚的外部序号仍会产生正常跟随结果。写盘失败保留输入义务，关闭控制器后不写迟到基线。

只读订阅没有“本轮输入参与者”，因此不会伪造输入完成 @；每条已接收输入保留原 actor/chat/account 并在原卡结果同步后通知。Herdr 没有强原生轮次 ID，不能把不同人的输入猜成同一任务后合并归属；相同聊天的被动订阅可共用展示，但不能转移原授权身份。多用户/跨群/撤权/重建已有直接用例。失联时最近读取时间仅代表旧快照，未承诺连续事件不丢；一个轮询间隔内完成、且接口没有序号的外部任务可能不可见。

## 能力的含义

支持标志同时带语义。`read=terminal-screen` 不等于完整聊天历史，`send=terminal-write` 不等于精确原生轮次接收。unsupported 进一步区分 native-unavailable、not-adapted、configuration-required；原生提供但业务没接好的操作不能写成供应商没有功能。

Herdr 新建、命名及生命周期已接入独立生命周期账本。TUI 创建布局后先落盘，再启动 agent；App 创建只执行一次 space/tab 命令。App 资源命名仅允许独占 tab，关闭仅结束指定终端；不冒充聊天归档。审批、模型设置、原生消息队列等没有同合同接口，不能用键入 yes、模型 slash 命令或自建队列假装提供。

## 核验边界

### 生命周期与外部写入

`RuntimeLifecycleCoordinator.execute/save` 按来源索引保存指纹、阶段和中间资源；重复来源返回已有回执。execute 先落 writing，再调用 adapter；TUI 创建布局后先提交中间回执再启动 agent。磁盘失败、响应丢失或进程退出不能走重新执行分支。`RuntimeWriteGate` 让同一个资源的 send/interrupt/rename/close 共用短锁；不同终端独立，锁不跨远端任务运行期。

`parseRuntimeCreateCommand` 是字面参数解析器，支持引号及 `--` 后的 argv，不执行 shell 展开。`runtimeCommandTarget` 在能力判定前区分 Gateway、catalog、binding、record：切换目录设备不能改变已有审批或队列回执的目标。App 由窗口命令新建，以同一 core 观察结果；独占 tab 才能重命名，关闭只针对指定 terminal。TUI 每次从稳定 terminal ID 找当前 pane，避免把旧面板位置用于新进程。

### 文件作用域与异步边界

`runtimeFilesystemScope` 包含 endpoint、resource、project、cwd、machine，故文件传输不因 foreground 更新而失效，也不能因机器仍同名就继承旧目录权限。`PeerFiles.checkFilesystem` 在 host 解析后、块传输前、发布上传结果前再次检查；租约同时固定原连接和授权。`RuntimeFilesystem.files` 在远端下载后复核主机，失败释放私有副本。

`herdrFileHost` 固定 machine.list 的 name/id/target/via/session 和资源作用域；`verify/command` 再读同一事实源。脚本仅为固定 helper，参数经 base64 编码。`openHostSocketRelay` 传原始字节、处理背压与半关闭，限制连接数，退出仅清理自己的代理。`PeerIDEService.validateCurrent` 在目录 canonicalization 后重新核对项目根、资源与主机；`close` 清理租约、中继和自有进程，不停止 Herdr。

### Web 与 Taskboard

`AccountManager.getSessionHistory` 对终端展示转义快照，读前后核对 sessionExecutionStamp 和资源身份。`submitWebRuntimeInput` 复用同一交接/观察模块，管理页身份只可写明确的 managed route。模型/effort 与 stream 分开；拒绝原生设置不影响 Gateway 展示设置。

会话列表是本地绑定记录的投影。某个历史 Connector 在重启后尚未注册时，`sessionSummary` 保留该记录并标记 `executionUnavailable`，不能使整个列表返回 500，也不能将未知执行能力当作 Codex 原生能力。该标记不持久化；设备重新连接后恢复实时能力。Web 禁用该记录的模型/推理设置和原生提问入口，过程展示设置仍独立可用。

`handleRuntimeLifecycle` 创建时以当前选择的 Connector 为目标。显式 `--cwd` 属于该设备，不继承原聊天绑定的项目；省略目录时才校验并继承当前项目。创建成功前保留旧绑定。重命名仅在原生回执确认且绑定代际未变时同步当前本地记录的名称，并失效目录快照；不提前更新或重放未知操作。

`bindCatalogSession` 将成功绑定与首次可选画面读取分开。创建后启动切换可能使 `assertSameReadTarget` 拒绝第一帧；该帧仍丢弃，已提交的绑定保留，并明确提示通过 `/history` 重读，不误报创建失败或重建资源。提交前使用原来源守卫，提交后使用新绑定代次和当前 Connector 授权守卫；不能复用已因自身换绑失效的旧守卫，也不能向后来换绑的会话投递旧提示。其他错误不被统一吞掉。

`nativeConversationUnavailable` 由 Taskboard catalog 与 workflow 准备共同使用；没有结构化输出时，在查询模型/工具或写入执行记录之前拒绝依赖该语义的节点。任务 CRUD、普通工作说明和本地聊天名称保持各自原有权限与职责。旧原生注入适配器没有 descriptor 时保留兼容；真实多运行接口的 descriptor 查询错误继续抛出，不能静默假装可用。

查看 [增量四层检查](../../audits/2026-11-07-herdr-adapters/README.md)、[生产清单](../../audits/2026-11-07-herdr-adapters/production-checklist.md)及[真实环境记录](../herdr-test-environments.md)。已验证真实 Linux TUI/Codex CLI 生命周期及中断、Mac App PTY 生命周期及原生中断、App→Linux 文件往返/文本共享/code-server 工作台。生产 Connector 的真实进程骤停、Web 输入、全部命令目标和能力组合有独立证据。2026-11-08 已补探探真实钉钉往返、卡片更新和进程骤停；用户处理证书警告后，Mac 与 Linux 的真实浏览器编辑保存、终端命令、Git 视图及刷新重连均已通过，每种 agent 的 UI 行为不由这些结果认证。Web 只允许显式托管 Connector 的管理写入；Taskboard CRUD/普通工作说明保留，依赖结构化最终答复的节点明确拒绝终端画面。

### 真实 IM 展示与原生审批兼容增量（2026-11-08）

Herdr `RuntimeObservationController` 在读后身份核验通过后调用 `terminalScreen` 替换同一张卡的窗口，不再猜测 Codex CLI 阶段或工具类型。最新终端尾部按渠道容量展示，旧文字可以滚出；checkpoint 保存最近窗口与原卡句柄，最终也只在原卡收尾。终端状态与输入回执仍独立。Codex 原生阶段保留/续卡路径不变。详见[终端展示](terminal-presentation.md)。

原生 `AppServerRunner.runWithLease` 负责所有启动路径的应用接受回调屏障；原生服务器很快发出审批时，必须等待 `onTurnStarted` 完成，保证参与者与原会话来源已保存。应用接受失败时，原生请求保持未决，不制造答案或重复启动。普通、queue、容量恢复共用这一边界；Herdr 输入不走该路径。

文件审批 RPC 的 itemId 不是修改范围。原生适配器以相同 turnId + itemId 关联 item/started 的 fileChange 路径及操作类型；仅缓存有界展示元数据，在轮次/连接结束时清理。重连丢失事件时再用有界 thread/turns/list 读取，原生等待审批的 item 可能尚未进入历史，缺失必须明示。最多展示 20 项，不转发 diff/文件内容、不改变审批决策或 grantRoot。读取失败/身份不匹配明确显示明细不可用，仍由用户决定；读取后再次检查原连接和 pending 身份。IM 和 Web 使用同一不可变审批快照及版本。

### Gateway 冷启动与旧 host 标识

订阅枚举不以 host 名称前缀区分设备可用性。Connector 迁移可能保留 local 和 remote-ssh-discovered:*；它们与 peer:* 一样，冷启动时可能先有持久绑定、后有设备注册。明确未提交的通信读取失败保留订阅和不可用状态，待同一设备恢复；其他错误继续抛出，不选择备用执行器或重放输入。对应 HDR-20 三类启动恢复用例。
