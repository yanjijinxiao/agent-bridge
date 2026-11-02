# Taskboard 的原生执行与交互

## 职责与入口

AiChat 浮层经 web/src/api.ts 的 local/ai API 进入 server/app.mjs，再进入 AiChatService。新建议题事件由 app.mjs 触发 issue-automation.mjs；自动处理器只负责显式策略和事件合并，执行同样交给 AiChatService。两者不再调用 codex exec。

server/native-backend.mjs 只管理一个选定的 CodexAppServerGateway 实例，目录、执行、观察、额度和交互复用该实例。嵌入服务由 AccountManager.taskboardNativeBackend 借出同一个根模块适配器，src/taskboard/embedded-server.ts 注入该非 owning 客户端；独立启动的包加载相邻根目录的 dist/codex/app-server-gateway.js。发行物必须包含这份根构建，不存在缺少构建时回退到 CLI 的路径。

连接选项由部署决定，业务方法不按 Desktop/headless 分叉。独立 daemon 拥有原生任务，Taskboard 只拥有客户端和 SQLite 投影。显式私有 stdio 的生命周期仍属于宿主；不能将其说成可跨宿主退出的独立执行器。嵌入服务在该模式也借用同一连接，不另外启动核心；自定义可执行文件名也不再触发隐式切换到 stdio。独立运行的 CLI 部署默认使用原生 daemon。

## 原生目录与权限

模型来自 model/list；Skill 来自精确 cwd 的 skills/list；MCP 来自 mcpServerStatus/list。目录不是执行授权。模型和 effort 在创建会话及最终提交前重新验证；项目来源必须仍匹配会话创建时冻结的 workspace。当前项目的全部有效 realpath 根提供 runtimeWorkspaceRoots，不提供其他项目的设备目录。

Skill 选择身份包含 name 和具体 path，避免不同范围的同名 Skill 相互覆盖。展示标签与 prompt 中的原生 name 分开，不能用包含路径的选择 ID 代替原生 Skill 名。目录格式错误、原生错误或重复分页必须报告，不能编造模型/Skill 选项。

保留的 UI sandbox 枚举有历史语义，不能按字面重新解释：

| UI 值 | 当前文案 | 原生 sandbox | 审批策略/审核者 |
| --- | --- | --- | --- |
| read-only | 请求批准 | workspace-write | on-request / user |
| workspace-write | 替我审批 | workspace-write | on-request / auto_review |
| danger-full-access | 完全访问权限 | danger-full-access | never / auto_review；每次发送需用户确认 |

这些字段只由 owning UI 的明确设置提供。普通 Gateway 会话续聊省略 nativeSettings，继承原生权限；有没有审批回调不能决定沙箱或审核者。

## 接收回执和本地事务

一次 startTurn 先完成目录/根/设置检查和附件准备，再在同一 SQLite 事务保存 run、用户公开事件和自动处理 run 认领。写盘失败时没有原生输入，事务中的 running 状态和认领一并回滚。SSE 仅发送已提交的数据。

native_receipt 是内部投递事实，不直接返回给浏览器。它保存 clientUserMessageId、提交 phase、确认的原生 thread/turn 和临时附件目录。提交前先保存 submitting；onThreadCreated 保存线程；onTurnStarted 保存精确接收身份。公开 run 的 handoff 区分待交接、已接收和待核对，不把本地保存说成 Codex 已执行。

通信错误、缺少回执或进展同步失败保留 running/待核对；只有明确未提交的当前新输入、原生终态或原生执行错误才结束对应投影。未知输入不得被 startTurn 的重试自动重发。

## HTTP 回执与浏览器草稿

浏览器提交前在 localStorage 保存无正文的 kind/scope/UUID 回执。存储满则保留草稿且零 HTTP 写。服务端把 ai_chat_submissions 的 ID、kind、scope、输入摘要和目标 ID 与会话/轮次在同一 SQLite 事务保存；相同请求在运行、完成、服务重开后都返回原实体，不再次执行。不同内容、附件字节或目标复用 ID 被拒绝，实体删除后保留 tombstone，不创建替代任务。

POST 接收后丢 HTTP 回执时浏览器保留记录、禁止把当前草稿当重试发送。显式“核对原提交”仅 GET 读取该 UUID，unknown 继续保留；确认原轮次才清自己的记录，未编辑草稿才清理。结束本地核对不结束原生任务，之后发送明确是新输入。记录独立到每次操作，不能清另一个页面的后续提交；刷新不自动 POST。秘密答案不使用这个输入日志。

## 重启和停止

数据库启动只把没有原生回执的旧 exec run 标为 interrupted；原生 run 保持原状态。recover 仅用已保存的 thread/turn 或 clientUserMessageId 调用原生观察接口，不携带 prompt 或 queue ID。没有线程身份时保留待核对。该路径不创建替代任务。

公开工具详情在重连后从原轮次读取。run/item/type 的稳定事件 ID 令补读替换同一公开记录，避免 live item 与历史补读重复。私有 reasoning、审核器内容、hook prompt 和原始用户上下文不进入公开工具映射；工具字段有大小预算和敏感字段处理。

close 退休当前观察、表单和 SSE，不向独立原生任务发送 interrupt。文件在原生终态前保留，不能因为旧观察连接结束就删除正在执行的任务还需要读取的附件。明确停止通过 interruptTurn(threadId, turnId)，不能替换成“停止此线程当前最新任务”；中断 RPC 的确认也不等于已经收到终态。

Taskboard 通过同一 AccountManager release lease 参与交接保护。hasRestartBlockingWork 只报告原生写 RPC/答案 flush 等真实交接；已经由独立核心接收的任务不阻止 Gateway 重启。freeze 同步暂停新输入、明确停止及表单答案；取消发布后恢复，未发送的自动处理事件仍保留 dirty。

## 审批与提问

原生请求以原 thread/turn/item 和原生请求身份映射成当前运行的表单。选项只能来自该请求。复制标签不提交，读取目录不批准。普通问题支持原生建议和自由填写；受约束的表单按类型/枚举展示，秘密输入使用 password。

答案只有当前 thread/run 和请求身份仍一致时才能提交。答案不保存为事件或 localStorage。提交后等待原生确认；失败时先重新观察原请求。再次出现的原生 pending 请求必须产生新的未决 promise，不能返回已经解析为旧答案的 promise，从而无意重发答案。

NativeInteractionFanout 按消费者拥有订阅。Taskboard 的审批/提问通过该观察接口接入，避免 active handler 抢走 IM 的路线。晚加入者可看到仍待处理的原请求；第一份仍有效的明确答案提交一次；替换或移除消费者后，其旧 promise 不能再答。移除 UI 只移除 taskboard 消费者，不撤销 IM。待确认答案失败后重新观察，不能返回已解析的旧 promise。实际原生服务测试覆盖晚 IM 加入及 UI 关闭两种情况；其他消费者任意组合仍须按来源合同验证。

## 自动处理策略

taskboard_automation_runs 为每个项目保存 thread/run/dirty。run 创建事务在发送原生输入前写入该认领。运行中的新事件只置 dirty，原任务结束后重新读取策略再决定是否启动下一次 drain。重启沿原 run 继续观察，不重复启动。

浏览器缓存仅用于展示。打开项目/菜单总是 list，不把旧 enabled 缓存重新 apply-policy。只有明确设置操作保存策略；目录读取不会启用策略。模型菜单使用当前原生目录，捆绑的旧模型列表仅用于历史 scheduler 格式。持久策略只校验结构，真正可执行性由当前原生目录验证，不能因静态表缺少新模型就丢弃用户原记录。

Desktop 注入器仍有窗口嵌入、composer 预填和旧 Cron 的只读查询/明确停用桥接。标准 App Server schema 没有 scheduler 管理方法，这些 UI/旧格式管理不是第二条任务执行器；不能伪装成原生执行接口已提供 scheduler API。额度读取已经改为同一根适配器，未新起私有 stdio helper。

## 验证与限制

- test/taskboard-native-integration.test.ts 使用实际安装的 0.166.0、临时 Home、SQLite 和本机假模型，验证目录/权限、公开结果、观察重启、原生审批、自动处理认领/停用及 UI/晚 IM 多消费者。没有接触真实用户任务。
- test/native-settings-integration.test.ts 验证实际原生图片输入、显式设置、同一核心身份。首次图片夹具本身损坏，已换有效 PNG；这不是产品图片缺陷。真实目录也揭示同名 Skill 不能按 name 全局拒绝，已用具体文件身份修复。
- Taskboard runner 的直接 case 覆盖同线程锁、并行线程、未知接收不重放、精确停止、秘密问题、答案 flush 未知、事务失败和附件跨观察生命周期。
- 隔离 Chrome 渲染生产表单和 App；已用旧 App 复现打开项目重提 enabled 缓存的失败，再验证 read-only list。它不等于真实钉钉或手机验收。

当前证据记录、尚未验证的连接/多观察者组合及正式部署状态继续由 completion-worklog.md 和需求清单维护；此说明不宣称整仓审查已经结束。
