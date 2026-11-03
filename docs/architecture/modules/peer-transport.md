# Connector 模块与接口契约

本模块把已授权设备上的 `CodexBridgeBackend` 接到现有 Gateway。机器人仍由原渠道适配器负责，输入策略、角色、审批卡片、复制控件、队列编排和投递沿用主链路。Connector 不运行第二套 agent 调度器。配置与操作见 [功能说明](../../gateway-peers.md)，资源共享见 [共享说明](../../peer-sharing.md)。

## 边界和职责

| 模块 | 职责 | 不持有的权威 |
| --- | --- | --- |
| `transport.ts` / `rpc.ts` | 主动连接、WSS、设备凭据、心跳、请求关联和帧限制 | 聊天准入、原生任务是否完成 |
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
- `files.version: 1`、`management.version: 1`、`sharing.version: 2`：分别约束文件、管理和资源授权协议。
- 后端本身不支持的能力保留原生 capability 错误。固定 thread 和资源委托限制的是授权范围，不是备用执行器选择。

`runEphemeral` 没有 host 参数，是 Gateway 自身的临时推理入口，保持原职责。远端新线程/临时线程经有 host 的 `run` 调用，需要完整设备授权；固定 thread 不能创建新线程。进程诊断同样需要设备授权。

## 输入、队列和恢复

写请求由主机、方法、账号、聊天、操作者、源消息 ID 派生操作 ID。设备先落盘提交意图再执行。已完成重复请求返回原结果；接受或未知状态不能自动重放。队列只转发原生 add/list/delete/run：Gateway 仍使用既有 NativeQueueCoordinator。设备保存来源映射，使重启后的 queue/history 返回原来源 ID；不同操作者不能借用这份映射。

新建线程的 onThreadCreated 是必须成功的持久身份交接，不属于尽力投递事件。设备保存 created 回执后必须等 Gateway 回调成功，原生适配器才可 turn/start；回调拒绝/断连保留设备记录并阻止输入提交。普通进展事件仍可尽力投递。IN-02.7 使用真实 AppServerCodexRunner 和 JSONL 协议夹具分别验证失败零提交及正常一次提交。

共享文本编辑器的保存请求捕获文件路径、内容及编辑/视图代次；响应只能清除同一版草稿的 dirty。保存期间仍可输入，但写请求串行，下一次保存使用已确认的新 hash；打开其他文件或重新打开同一路径后，旧响应不能改新视图。读取期间的新输入也不能被迟到文件内容清掉。WEB-01.7 覆盖这些状态边界；它不是完整 code-server 或手机视觉验收。

队列 add 返回不代表后续回调结束。回调保留到原生终态、显式删除/消费完成或连接关闭，保持审批请求与结果的对象身份。断连将 UI 标为 withdrawn/failed，不为原生生成 decline。未知接收通过历史和精确 client ID 读取恢复。

容量续跑的随机来源ID属于线程级coordinator，获准读取该线程快照的来源可用于核对同一回执；普通队列映射仍严格按操作者隔离。容量恢复复用现有 coordinator 和原生空输入续跑接口，不重发旧 prompt。后台恢复必须取得仍有效的具体账号/聊天/操作者和绑定守卫，不能随便选一个配对身份。系统恢复在 Gateway 和 Connector 都记录恢复责任后才 archive；Connector 重启先补偿原线程 persistence，禁止在此启动推理。恢复完成回执丢失时，保留设备侧完成记录供 Gateway 再确认。

## 公共代码改动与兼容性

保留的公共扩展均有 Connector 调用方：异步最终写检查、后台来源上下文、按 consumer 的交互退休、文件 scope、浏览器授权截止时间。同步守卫继续同步执行，本地/SSH 端口保留原参数和对象。新增线程端口复用同一原生适配器；原生尚未物化的空线程需保留订阅到首条输入，不能承诺首条输入前已持久化。

通用 `/session rename|archive|restore`、`/sessions archived`、Desktop 归档目录及项目别名展示调整移到后续分支。Connector 不通过这些额外命令改变本地或 SSH 的既有产品行为。原生生命周期端口仍可由已获授权的调用方使用。

## 验证与范围

- `backend-transport-contract.test.ts`：同一份原生 JSONL 场景驱动本地、SSH 路由和 Connector，覆盖目录、模型、额度、Skills/MCP、队列、交互、动态工具、生命周期和撤权；环境变量可把 SSH 路由切到真实远端。
- `peer-main-orthogonality.test.ts`：默认、本地、SSH 三组端口参数/回调对象/receiver 不变；没有混入已拆分的通用命令。
- `peer-complete-contract.test.ts`：迟到队列回调、重复源身份、拒绝分类、恢复守卫、回滚日志及元数据观察选项。
- `peer-real-native.test.ts`：真实 Codex daemon + 临时 Home + 本地模型，验证断线后的原生队列及来源恢复。
- 原有 peer 文件、共享、审批、恢复测试继续运行；main 全量回归单独报告。

完整 code-server、Taskboard UI 的远端产品接入和通用远端 Channel 是独立集成范围；本模块提供原生端口，不声称这些产品入口已经接线。Windows 路径、真实第二用户和所有 IM 客户端不以 Linux/macOS 协议测试代替验收。当前结果以 [合入审查记录](../../peer-merge-readiness.md) 为准。
