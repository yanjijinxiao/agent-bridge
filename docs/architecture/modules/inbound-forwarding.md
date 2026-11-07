# 消息接收、转发与原生接收回执

Herdr 开发增量：runtimeInput 标记终端来源，明确排除原生历史/队列恢复。Gateway 丢失响应后通过独立 runtimeReceipt 查询 Connector 原来源、目标、指纹；recoverRuntimeAccepted 只修复相同 actor/chat/session/host/thread 的非活跃记录，不添加 turn/queue 或 recoveredNativeInput，不重发。屏幕观察和结果卡由独立观察 journal 持有，详见[运行模块](agent-runtime.md)。

本模块保证 Gateway 已接收的来源和交接记录可核对，区分“还在准备”“已尝试但未知”“原生明确接收”。它不拥有 Codex 的任务执行顺序和任务生命周期。以下描述当前实现，不把未完成的组合验证写成保证。

## 事实由谁持有

| 对象 | 唯一写入职责 | 实现 |
| --- | --- | --- |
| 平台事件身份、业务 ack | 渠道适配器；持久 claim 失败不能当作成功接收 | src/channels 下各渠道 |
| 正文、附件描述、原始目标、待转发状态 | 每账号共享的 ForwardingInbox；保存规范化消息，不保存带 webhook 凭据的原始回调 | src/bridge/forwarding-inbox.ts |
| 来源是否尝试/接收/处理 | 每账号共享的 InboundReceiptJournal；只保存来源和精确回执，不保存正文 | src/bridge/inbound-receipts.ts |
| 当前绑定、执行代次、角色 | RuntimeStateStore；来源 guard 在等待后复核 | src/state/runtime-state.ts、src/bridge/session-execution.ts、service.ts |
| 运行中补充的写入回执 | SessionControlJournal；按 host/thread 串行短控制写入，不串行整个任务 | src/bridge/session-control.ts |
| 原生队列交接与恢复回执 | NativeQueueCoordinator 保存来源和 ID；prompt 与顺序保存在 Codex | src/bridge/native-queue.ts |
| 普通轮次接收 | TurnSubmission 在原生接收事件前后分别记 submitting/accepted | src/bridge/turn-submission.ts |
| 任务执行、线程、原生队列及终态 | 选定主机的同一个原生 App Server | src/codex 的原生适配器 |

AccountManager 为同一账号复用 journal/inbox，不允许每次消息新建互不知情的状态实例。实际接线见 account-manager.ts 的 receiptsFor、forwardingFor、dispatchChannelMessage。

## 正常调用路径

1. 适配器取得可信 actor、conversation、平台消息 ID，调用持久 claim。claim 先保存 body-free 来源回执，再保存完整 inbox；任何保存失败均不能派发或确认成功。
2. inbox 捕获 session、host、thread、执行代次、项目、多根目录和模式。Gateway 不可写时只保存，不替用户新建执行器。
3. 派发调用 journal.handle，再进入 BridgeService.handleMessage。原 actor 与 replyTarget 分开保存；群 ID 不替代操作者身份。
4. 解析引用、附件下载/远端转存、状态读取均属于准备。异步等待后核对原绑定、执行代次、准入和最低角色；拒绝后不把旧输入转向新线程。
5. 真正提交前保存 submitting，再调用选定原生接口。原生确认由精确 thread/turn 或原生 queue ID 标识，不按相似文字推断。
6. 确认接收后 inbox 可以移除正文并释放后续输入的转发顺序；执行和进展订阅仍继续，原任务无需等待下一条输入。

普通消息仅显式斜杠命令才进入 Gateway 控制。运行中默认 steer；显式 /queue 使用原生队列，Gateway 不建立第二个执行队列。

## 输入来源回执

| phase | 含义 | 中断/异常后的处理 |
| --- | --- | --- |
| received | 来源已持久保存，尚无提交尝试证据 | 可以重新认领准备；不代表 inbox 会无条件自动重试 |
| submitting | 提交前已持久记录，外部结果尚未确认 | 崩溃恢复视为未知；不能因缺少响应重发 |
| accepted | 原生精确接收事件已持久保存 | 后续读状态、渲染或投递失败不撤销接收事实 |
| handled | dispatch 已完成；也可能只是本地命令或拒绝提示 | 去重 tombstone；不等于 Codex 完成了任务 |
| unconfirmed | 提交尝试发生后缺少足以判定的回执 | 保留来源，只核对原生记录，不自动重放 |

journal.handle 仅在“明确未提交”的通信错误、能力/准入拒绝时将 submitting 恢复为 received。泛化异常和 CodexInterventionError 本身不能证明此前没有外部写入；不能全局捕获后无条件降级。已有 accepted 回执优先于晚到错误。

received 记录与 inbox 的 pending/held/unconfirmed 是两个维度。普通自动转发在已知前置不可用时可有界重试；换绑、普通准备异常及控制命令可能停在 held。用户显式处理仍受原 actor、conversation 和当前目标版本约束。不要把“可以认领”写成“自动换绑重发”。

## 不同命令的写入边界

- 普通轮次：prepareTurnSubmission 完成后，TurnSubmission.run 先复核来源，再记录 submitting，随后进入 backend.run。
- /steer：附件准备和 inspectThread 完成后复核来源，再记录 submitting 并进入短控制写入。后端仍须在实际原生请求前执行 assertCurrent，防止后续等待期间来源变化。
- /queue 加正文：解析附件、状态读取和远端转存后，先复核来源，再记录 submitting；NativeQueueCoordinator 再次检查 guard 并写自身持久回执，随后 queue/add。
- /queue cancel、/stream、Taskboard 等控制：可能先修改本地或外部状态，仍在命令分发处保留保守的 write-ahead 标记。回复丢失不能自动重做已发生的副作用。

2026-11-02 复核确认旧 handleCommand 为所有命令提前标记 submitting，导致 /queue 下载与转存、/steer 转存期间换绑，在零后端写入时仍留 unconfirmed。已仅延后拥有独立输入边界的 steer/queue 正文分支，并把 queue 标记移到来源复核之后。steer 的状态读取返回后也补复核。没有把所有命令统一重置为 received。

## 重启、去重与观察

Gateway 重启只结束自身连接与交接过程；已经由独立原生执行器接收的轮次继续运行，恢复后按原 thread/turn 跟随，不重发输入。RestartWork 的豁免还要求后端确认该 scope 的独立性，不能仅看到 threadId 就放行；实际审批答案和结果发送仍有各自保护。

2026-11-08 探探真实附件验收发现 `/prompt done` 原本作为控制命令绕过输入顺序，可能在附件后的文字仍待处理时提前提交。现在 `ordersPromptInput` 仅将 start/s、done/d、cancel（包括菜单/卡片来源）加入输入保序；`ForwardingInbox.ordered` 与 `automatic` 分开，前者不能赋予重放权限。先前输入处理完成才提交合并区，等待期间 attempts 不增加，因此未执行的控制可在重启后继续；已经尝试、结果未知的控制仍保留回执且不重放。`/status`、`/stop`、审批及只查看 `/prompt` 不受该顺序限制。无新持久字段，旧 version 1 inbox 可直接读取。46 项 forwarding-inbox 回归含真实 BridgeService 缓冲区、处理前重启、未知命令和控制旁路；探探 v6 文件+说明快速提交已返回预期组合标记。

inbox 只对仍活跃的接收前交接保序。已结束但未知的旧记录保留待核对，不永久挡住新独立输入。控制命令不需要等整个原生任务执行完成。

SessionControlJournal 对 accepted 或未知记录均禁止重新调用同一来源。NativeQueueCoordinator 通过原生 clientUserMessageId、queue ID、turn ID 恢复；在队列或历史中“没找到”只得到 uncertain，不得到未执行。旁路历史终态不能覆盖实际执行者仍运行的事实。

队列接收和 IM 来源接收是两份日志，原生 client ID 也不同。2026-11-03 的真实骤停补测发现：原生任务和结果可恢复，但 queue/add 接收之后、IM queued() 落盘之前退出会留下未知 inbox。Bridge 恢复队列后，现在将当前账号下原 message/actor/conversation/session/host/thread 与已确认 queue/turn ID 一起交给 InboundReceiptJournal.recoverQueued。该方法只对相同版本、非活跃、非普通输入的 submitting/unconfirmed 做持久更新，再调用同一 accepted 清理；结果义务仍归 NativeQueueCoordinator/Hub，不创建第二份 recoveredNativeInput。清理失败仍由 inbox tick 重试；停止后的服务不提交迟到更新。

普通输入的真实崩溃恢复由AccountManager.recoverNativeInputs和native-input-recovery共同完成。TurnSubmission在新建thread后、turn/start前持久补上thread ID；恢复只读取原host/thread，完整分页精确clientUserMessageId唯一对应turn后才CAS更新accepted并清理inbox。读取不占转发/重启锁，已停止或替换的账号不接受迟到更新。旧普通来源可补足类型，旧queue/控制或缺thread身份不猜测。

恢复accepted还保存recoveredNativeInput结果义务。Hub在处理结果前核对输入，按同一session/host/thread/conversation排除历史baseline误吞已离线完成的首次结果；不会据此重放无关历史或覆盖新的活动轮。Hub持久保存最终投递后才结算该义务为handled，二次崩溃根据原投递记录继续。结果附件动作沿用共用动作日志去重。

## 持久化和故障

来源 journal 使用 append + fsync，提交标记落盘失败禁止派发；尾部不完整 append 截断到上一个完整记录，保留旧 accepted/submitting。持久化 transition 失败恢复内存旧值，不能让内存的成功比磁盘更强。坏版本或结构拒绝读取并保留原文件，不静默重建空去重记录。

inbox 使用私有权限的原子文件，保留规范化正文与附件描述；准备后的附件先核验文件并 fsync，再保存路径。原始 provider raw 不落盘。转发提示有独立去重，提示发送成功不代表 Codex 接收。

原生控制和队列各自保存短操作回执；它们不是业务任务锁。状态读取不占队列修改通道，迟到观察不得恢复已取消项。

2026-11-03 四层复核的隔离修复：控制/队列原子保存失败后重新读取实际文件，区别改名前失败与改名后目录 fsync 失败，避免内存伪占位或覆盖已落盘接收事实。队列重载保留其他线程仍在等待的回执对象身份。inbox 定时清理失败保留 accepted 来源并在后续 tick 清理，不让文件错误逃出定时器导致整个 Gateway 退出。

回执观察将短进展刷新预算与完整历史扫描预算分开；同一执行入口、原始身份、host/thread 和候选 client ID 集合复用只读扫描，不因每次进展刷新超时就从第一页重新开始。只有全页读取完成且 ID 唯一时才返回证明；部分页、重复 ID、超出完整扫描预算、关闭或异常均保留未知。结果不保存正文、不授权重发；账号持有者及 journal 版本仍由 AccountManager 在写入恢复事实前复核。默认完整扫描上限为 120 秒/10000 页，最多保留 64 个扫描，关闭执行入口时退休；这不保证任意长度历史都可在预算内读取。隔离 case 覆盖 25 页、跨刷新迟到重复 ID、不同身份隔离、关闭后迟到响应及超时后重新读取；实际供应商长历史另验。

## 场景与实际边界

| 功能契约 | 直接检查 | 仍不代表 |
| --- | --- | --- |
| IN-02.1 至 IN-02.3 | 真实文件与落盘故障；native-input-crash-recovery在真实原生接收与accepted append之间SIGKILL，6种已有/新线程、离线完成及再次崩溃场景 | 所有供应商重投窗口、主机断电或任意指令间隙 |
| IN-02.6 | attachment-source-binding：9 种准备等待 × 正常/换绑；重开真实 journal；另有本地命令已写入而回复丢失的对照 | 真实网络/App Server 中每一种断连时序 |
| IN-03 | 活交接保序、未知记录跨重启保留、不阻塞后续输入 | 所有最终卡片慢投递组合 |
| BIND 及控制 case | 准入/角色/绑定的独立 source-guard 测试；具体映射看需求清单 | 每个异步入口已覆盖所有降权、ABA 和多账号组合 |

多数窄场景的原生修改为替身；上述6种崩溃场景使用真实原生0.166.0核心和Gateway子进程，本机模型及IM端口为替身。完整测试名和源码散列见gateway-requirements.json与[恢复记录](../../audits/2026-11-01-four-layer-recheck/2026-11-02-native-crash-recovery.md)。

## 未解决的设计与验证边界

- 卡片准备/订阅只读等待、容量恢复 checking/settling 与 systemError pending 的重启保护粒度仍需分开验证，不能据本模块修复删除全局保护。
- 控制写入通道内及后端连接等待后的拒绝，仍可能保守地保留未知记录；缺少统一的“实际请求前拒绝”证据时不放开重放。
- Taskboard IM写入已由独立持久日志与服务端事务回执处理（TB-09.5）；浏览器部分附件另有独立记录。原生workflow交接未知及真实骤停组合仍保留TB-09.6，具体边界见taskboard-data-handoffs.md，不能沿用“仅内存去重未解决”的旧结论。
- 回执是否正确显示为钉钉/微信手机端卡片、复制控件与 IDE 页脚，须实际客户端验收。

## 远程结果文件回传

与入站转存分开：CodexAppServerGateway.fetchOutputFile复用选定host的remoteTransport，OUTPUT_FILE_SENDER只读打开远端绝对路径；路径经stdin传递，固定脚本命令不拼接文件名。拒绝末级符号链接、设备/目录、超限与读取期间变化；按配置maxInboundBytes及100MiB硬上限读取，返回长度和SHA256后由Gateway校验。

Bridge只在渠道声明支持该媒体类型时下载；校验成功写入私有临时目录和0600文件，保留原文件名。异步下载后复核原绑定与服务状态，再调用渠道；完成或失败都清理本轮副本，不删除远端源文件。原有TurnResultActions仍控制未知渠道发送不重放。自定义无SSH文件端口的执行器明确失败，不用本机同名文件冒充。当前自动化用隔离SSH进程替身执行实际传输脚本及真实Bridge；真实远端和手机仍需联调，历史Web附件下载端口仍不支持远程文件。

微信轮询来源身份：必须由供应商提供非空字符串或安全整数 message_id，不用 Date.now/random/hash 补造可执行输入身份。缺少 actor 的控制记录仍忽略；有 actor 却缺少身份或正文无法解析时，本批不得推进易失或持久游标，渠道显示正在重连并有界退避。同批有效消息仍进入既有持久 claim；重读后靠原消息 ID 去重，不重复提交已处理的输入。该处理可能因持续畸形记录滞留来源游标，这是明确的协议异常，不把跳过记录伪装成成功接收。
