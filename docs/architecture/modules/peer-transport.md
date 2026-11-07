# Connector 模块与接口契约

本模块是 Gateway 的唯一执行入口，同机也通过 Connector。Codex 设备复用原生适配器；源码中的 Herdr 使用同一设备授权和传输下的独立运行端口，不伪装原生 thread/turn。机器人、角色、共享、文件与展示继续共用，Connector 不运行第二套 agent 调度器。配置与操作见[功能说明](../../gateway-peers.md)，共享见[共享说明](../../peer-sharing.md)，Herdr 边界见[运行模块](agent-runtime.md)。

## 边界和职责

| 模块 | 职责 | 不持有的权威 |
| --- | --- | --- |
| `transport.ts` / `rpc.ts` / `gateway-trust.ts` | 主动连接、WSS、设备凭据、心跳、请求关联和帧限制 | 聊天准入、原生任务是否完成 |
| `registry.ts` / `context.ts` | 设备注册、短期配对码、精确 account/conversation/actor 授权、回调租期 | 原生会话历史、工具授权 |
| `backend.ts` / `contract.ts` | 完整 facade 端口分类、选 host、DTO 与错误类型适配、后台来源恢复 | 本地或 SSH 业务的替代实现 |
| `execution-service.ts` | 核对设备侧 grant/thread/cwd，调用原生 facade，转发回调 | 自己解释模型、排队或调度恢复 |
| `write-guard.ts` | 最终原生写入前回查 Gateway 来源，并再次检查设备权限 | 网络存活不能替代角色或绑定校验 |
| `receipts.ts` / `identity.ts` | 持久操作身份、提交阶段、原始来源与原生来源映射 | 未确认不能当作未执行 |
| `interaction-client.ts` / `interaction-service.ts` | 独立交互订阅、consumer 区分、原请求对象、断连退休和重播 | 不默认同意或拒绝原生请求 |
| `recovery-journal.ts` | 设备侧线程持久化恢复责任；重启只补偿恢复 active | 补偿不能启动推理或重放 prompt |
| `project-catalog.ts` | 仅Connector侧将项目目录投影为原生session相同的明确迁移身份 | 不改变Gateway本地/SSH的项目列表 |
| `management.ts` / `files.ts` | 原生管理端口、文件分块与哈希、路径与资源范围 | 不新增通用聊天管理命令 |
| `sharing-*` / `shared-workspace.ts` | Owner 准入、独立文件/目录授权；复用 IDEAuthorization | 不另建 read/chat/control 角色体系 |

## 端口覆盖与协商

`PEER_BACKEND_CONTRACT` 用 `Record<keyof CodexBridgeBackend, ...>` 穷尽公共端口。新增一个 facade 方法而遗漏分类会导致类型检查失败。具体接口分组见 [接口表](peer-interface-matrix.md)。分类不是测试通过证明；每类仍有独立反例。

- `writeGuard: 1`：所有写操作的最低版本要求。旧设备缺失此标识时明确拒绝写入。
- `nativeContract: 1`：队列、恢复、Skills/MCP、原生设置、动态工具和新线程执行。Gateway 不静默丢弃这些参数。
- `interactions: 1`：独立原生审批/问答观察；按 thread + consumer 管理订阅。
- `runtimeContract: 1`：资源 read/send/interrupt/receipt/lifecycle；独立于 nativeContract。只读 receipt 核对原来源及指纹，不发送输入；screen 不是原生消息历史。五个端口使当前 facade 显式分类总数为 57；尚未发布此新增合同。
- `files.version: 1`、`management.version: 1`、`sharing.version: 2`：分别约束文件、管理和资源授权协议。
- 后端本身不支持的能力保留原生 capability 错误。固定 thread 和资源委托限制的是授权范围，不是备用执行器选择。

`runEphemeral` 可携带明确的 hostId，通过同一 Connector RPC 创建只读临时线程；省略时仅使用配置的逻辑 local 路由，缺失就明确失败，不借用另一人的设备。远端新线程/临时线程经有 host 的 `run` 调用，需要完整设备授权；固定 thread 不能创建新线程。进程诊断同样需要设备授权。

## 输入、队列和恢复

写请求由主机、方法、账号、聊天、操作者、源消息 ID 派生操作 ID。设备先落盘提交意图再执行。已完成重复请求返回原结果；接受或未知状态不能自动重放。队列只转发原生 add/list/delete/run：Gateway 仍使用既有 NativeQueueCoordinator。设备保存来源映射，使重启后的 queue/history 返回原来源 ID；不同操作者不能借用这份映射。

新建线程的 onThreadCreated 是必须成功的持久身份交接，不属于尽力投递事件。设备保存 created 回执后必须等 Gateway 回调成功，原生适配器才可 turn/start；回调拒绝/断连保留设备记录并阻止输入提交。普通进展事件仍可尽力投递。IN-02.7 使用真实 AppServerCodexRunner 和 JSONL 协议夹具分别验证失败零提交及正常一次提交。

共享文本编辑器的保存请求捕获文件路径、内容及编辑/视图代次；响应只能清除同一版草稿的 dirty。保存期间仍可输入，但写请求串行，下一次保存使用已确认的新 hash；打开其他文件或重新打开同一路径后，旧响应不能改新视图。读取期间的新输入也不能被迟到文件内容清掉。WEB-01.7 覆盖这些状态边界；它不是完整 code-server 或手机视觉验收。

队列 add 返回不代表后续回调结束。回调保留到原生终态、显式删除/消费完成或连接关闭，保持审批请求与结果的对象身份。断连将 UI 标为 withdrawn/failed，不为原生生成 decline。未知接收通过历史和精确 client ID 读取恢复。

容量续跑的随机来源ID属于线程级coordinator，获准读取该线程快照的来源可用于核对同一回执；普通队列映射仍严格按操作者隔离。容量恢复复用现有 coordinator 和原生空输入续跑接口，不重发旧 prompt。后台恢复必须取得仍有效的具体账号/聊天/操作者和绑定守卫，不能随便选一个配对身份。系统恢复在 Gateway 和 Connector 都记录恢复责任后才 archive；Connector 重启先补偿原线程 persistence，禁止在此启动推理。恢复完成回执丢失时，保留设备侧完成记录供 Gateway 再确认。

## 公共代码改动与兼容性

配对和新建会话后的绑定属于同一条用户操作：进入时捕获的聊天、角色和绑定代次必须跨异步原生读取保留，不能在绑定辅助函数中重新取得新代次，覆盖期间用户的新选择。配对授权本身可以保留，但过期的自动绑定不得提交，也不启动任务。

`/status` 轻读所选设备的原生会话模型/推理强度；普通提交不携带 Gateway 的历史覆盖值。模型、effort 和计划模式的显式修改共用 `updateThreadSettings` 端口，只通过原生 `thread/settings/update` 生效。桌面后改设置以原生最新值为准，Gateway 和 Connector 都不保存执行替代值。元数据查询只携带 `timeoutMs/purpose`，线程状态查询另有 `includeTurns: false`；Connector 继续严格校验各自 DTO。元数据读取前的线程身份核对也必须传递同一只读观察预算。读取失败只能展示未知，不能用本机默认值伪装远端结果。

审批可以通过项目通知路由发送到尚未绑定该任务的聊天，但它只有在 host、thread、turn 都匹配时才能改变已有进展卡。相同 thread/turn 字符串不能替代主机身份。

附件发布前的原生线程检查是异步边界。检查返回后必须重新核对授权、连接存活及同一传输租约仍在登记，再校验哈希和发布文件；失效则清理临时分片，不能只凭检查前的授权继续落盘。

保留的公共扩展均有 Connector 调用方：异步最终写检查、后台来源上下文、按 consumer 的交互退休、文件 scope、浏览器授权截止时间。同步守卫继续同步执行，本地/SSH 端口保留原参数和对象。新增线程端口复用同一原生适配器；共享核心保留订阅供首条输入使用，显式私有 stdio 仍按空闲策略退休连接。空线程的原生元数据必须可读、可继续，不能靠占位输入维持线程。native-empty-thread.test.ts 在两种传输下核对创建后读取及首条输入只执行一次；该证据不外推到所有原生版本和任意崩溃窗口。

通用 `/session rename|archive|restore`、`/sessions archived`、Desktop 归档目录及项目别名展示调整移到后续分支。Connector 不通过这些额外命令改变本地或 SSH 的既有产品行为。原生生命周期端口仍可由已获授权的调用方使用。

## 验证与范围

- `backend-transport-contract.test.ts`：同一份原生 JSONL 场景驱动本地、SSH 路由和 Connector，覆盖目录、模型、额度、Skills/MCP、队列、交互、动态工具、生命周期和撤权；环境变量可把 SSH 路由切到真实远端。
- `peer-main-orthogonality.test.ts`：默认、本地、SSH 三组端口参数/回调对象/receiver 不变；没有混入已拆分的通用命令。
- `peer-complete-contract.test.ts`：迟到队列回调、重复源身份、拒绝分类、恢复守卫、回滚日志及元数据观察选项。
- `peer-real-native.test.ts`：真实 Codex daemon + 临时 Home + 本地模型，验证断线后的原生队列及来源恢复。
- 原有 peer 文件、共享、审批、恢复测试继续运行；main 全量回归单独报告。

完整 code-server 通过 IDEHostTransport 和独立 ide.call/ide.stream 接线，职责见 IDE 模块文档及本次审计。Taskboard UI 的远端产品接入和通用远端 Channel 仍是独立集成范围。Windows 路径、真实第二用户和所有 IM 客户端不以 Linux/macOS 协议测试代替验收。当前结果以 [合入审查记录](../../peer-merge-readiness.md) 为准。

共享入口的登记也属于持久状态：entry(ref) 只有在快照写盘成功后才更新内存并返回链接；失败不能累积占用入口额度。200 条上限只计算授权仍存在且资源身份仍匹配的入口；本地明确撤销/过期的授权可在下一次登记时清理，不能依赖重启，因为入口本来就跨重启保存。离线设备、网络失败不等于授权撤销，不能据此清理仍有效的固定入口。PEER-04.3 已用四个原版失败反例验证修复，并通过既有共享授权回归。

## 完整 IDE 传输

可选 `fullIDE: 1` 声明设备明确启用的完整 IDE。`ide-service.ts` 持有设备侧原生项目和租约，`ide-transport.ts` 适配既有 IDEHostTransport，`ide-stream.ts` 在已有 WSS 上有界传输 HTTP/WS。它们不新增 Codex 执行端、不复用原生任务为 SSH 命令通道。设备授权与浏览器个人身份双重核验，委托文本权限不能获得终端。

关闭、撤权、取消和迟到 launch receipt 必须只清理自有 lease；连接关闭退休字节流。非法块、并发未确认块、重复/乱序、EOF 后数据销毁该流，不关闭其他原生会话。管理 UI 不向 Connector 展示无效的 SSH/binary/自动安装输入，设备配置拥有这些选择。

## 固定入口的证书信任

PEER-01.3：Connector 在没有显式 CA 时，仅为 wss://11.158.199.29:49186/gateway/v1/peer 使用随发布包内置的探探公开 CA。`gateway-trust.ts` 负责准确 URL 匹配和信任材料选择，`transport.ts` 继续由 Node TLS 验证证书链、有效期和 IP/主机名，并关闭重定向；业务、配对和设备凭据仍走原路径。无匹配的其他 Gateway 保持默认系统/Node 信任，显式 CA（包括错误/空内容）优先且失败不回退。不会联网下载并自动信任证书，不修改系统信任库，不发送凭据给不受信服务器。

内置的是持久 CA，不是短期服务证书。服务器沿用 `IDETLSManager` 准备该 CA 下的服务证书；同 CA 续签无需更改用户配置，CA 更换必须先发布新信任并协调客户端迁移。公开 CA 可以随代码发布；私钥仅保存在部署主机的受限目录。浏览器 IDE 的信任和授权是独立层，Connector 内置信任不会修改浏览器信任库。

`test/peer-trust.test.ts` 覆盖固定入口、省略 CA、覆盖优先级、其他地址/端口/协议/路径/查询不继承信任，以及真实本机 TLS 中不可信证书/错误 IP 被拒绝；线上双端省略 CA 的验证单独记录，不把本机 TLS 夹具等同于真实 IM 多用户验收。


## 设备自助登记（PEER-01.4）

服务端 listen.enrollment 显式开启后，未知设备可携带程序本地生成的随机身份请求受限登记。transport 同时限制 64 个待登记连接、每分钟 64 次登记连接和 5 分钟存活期；已登记 ID 的错误密钥拒绝，不回退到登记。未登记 host 只保存在配对票据内，不进入可执行或 IDE 设备目录，也不能替换已有连接。

/connect 复用原有聊天准入、角色守卫和设备本机 binding.approve。异步返回后重检来源、连接和期限；先持久化设备摘要，再保存 grant，最后发布 host。设备摘要写失败没有任何授权；grant 写失败留下可重连的认证身份，但不开放会话，后续重新配对。失败的待登记连接关闭并重新取得配对码，不重发输入。凭据由 credentials.ts 管理，Gateway 只存摘要，本机 device-identity.json 为 0600。新配置可省略 nodeId/tokenFile，旧配置必须二者同时保留且继续使用原状态路径。

设备凭据不是用户或资源授权；删除凭据不能替代撤销会话 grants。新协议没有新增 App Server 执行器，也不更改原生任务生命周期。关闭自助登记只拒绝未知设备，已登记设备继续认证。管理员可在停止入口后移除 .devices.json 中指定设备记录，再启动入口以撤销该设备；旧静态 devices 需同步移除，不能宣称已有热撤销管理 UI。

## 同机与历史主机迁移

`managed-route.ts` 定义双端配置的逻辑 host 到 node/profile 映射，`registry.ts` 分离路由与个人配对权限。托管身份只能由预配置设备认证注册，不能自助登记抢占。`session-monitor.ts` 将原本 Gateway 读取本机 rollout 的观察迁到设备侧；停止观察不发送 stop。`AccountManager` 缓存设备投影的项目元数据，IDE 校验刷新设备目录，不再读取 Gateway 的 Codex Home。兼容层 `withPeerBackend` 仅保留给嵌入调用方和旧接口测试，生产只创建 `connectorOnlyBackend`。

新增验证：`connector-only.test.ts`、`peer-ide.test.ts` 的本机/远端托管组合、`backend-transport-contract.test.ts` 的 managed-connector 原生契约。完整边界见 [迁移契约](../connector-only-execution.md)。

托管迁移的文件回传保留旧主机导出能力（包括临时目录），授权只来自双端预配置的 managedRoute；个人 grant 保留工作目录及收到附件的边界。PeerFiles 在最终授权后检查文件、尺寸及稳定性，分块传输仍受连接与授权租约约束。此差异对应 NAT-07.8，不能仅凭 host 名或注册声明放宽范围。

主机通道与身份约束见 [Connector 多主机路由](../connector-host-routing.md)。host-scoped-backend 对所有 facade 方法穷尽声明 host 位置；rpc.channel 只复用连接，业务仍由同一个原生后端处理。

输入附件也遵守这一边界：Bridge 的 stageTurnAttachments 必须对所有主机名传递账号、聊天、线程，不能以 `peer:` 前缀决定是否传递授权范围，也不能把逻辑 `local` 当成 Gateway 文件系统。后端端口自行决定直读还是转存；纯文字不调用文件端口。TurnAttachmentError 只表示提交前附件准备失败，保留原始 cause，用户文案明确尚未提交；不会更改原生任务结果或触发重发。NAT-07.11 从真实 BridgeService 经 Connector WebSocket 验证，而非在测试中手工补齐文件 RPC 参数。

## VER-01 版本协商与实例诊断

统一规则见 [版本契约](../version-contracts.md)。设备认证之后，Connector 先以独立 protocol.negotiate RPC 报告本进程版本，再发送原样 peer.register。只有旧端明确 unsupported 才继续 legacy；不兼容、超时或断线均不能进入新注册。原生执行能力、资源 grants 和实际版本是独立信息，不从版本推导授权。

Registry 保存已发布连接的版本快照，根设备和导出的 nativeHost 路由共享同一 Connector 身份；重连更新实例，离线保留本进程最后一次快照。新旧混用、拒绝后继续请求、超时与重连均由 runtime-versions.test.ts 覆盖。协商失败不重发任何业务输入、不换执行器。
