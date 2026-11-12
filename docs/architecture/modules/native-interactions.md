# 原生审批、问题与多消费者

AppServerRequestMonitor/Runner 观察原请求；InteractionRouting 选择仍有效 IM 来源。审批选项、提问字段、原 thread/turn/item/request ID 都属于原生请求。Bridge 只能展示并回传用户明确答案，不能因路线不存在、重启或 UI 关闭而生成默认允许/拒绝。

## 共享观察与退休

NativeInteractionFanout 每个 host/thread 保留一个底层观察者，按 gateway/taskboard 等消费者分发当前未决请求。晚订阅能获得原 pending 请求；第一份仍有效的明确答案才可提交。替换或移除消费者使其旧 promise 失效，不能注销另一个消费者。更新后的同 ID 请求不复用旧已解析答案。

并发回执按实际获选的消费者分配。原生 confirmed 只确认被提交的那份答案，其他入口得到 withdrawn，不能把 Web 的拒绝算作 IM 的允许已生效。failed 是确认未知，保留已选消费者身份直到原生 confirmed/withdrawn 或观察者退休；不重放答案。消费者被替换后，旧获选者的回执也不能确认新消费者的同 ID 答案。

Taskboard 通过观察消费者接入，不在 run 上安装抢占 IM 的 active handler。原请求回到表单后才允许再次选择；答案 flush 未知先观察，不自动再送旧决定。NativeAsyncQuestions 的通知微任务和最终写前均核来源；撤回、peer 已答、编辑和实际 turn end 退休旧内容。连接或观察者消失只挂起未答的异步 widget，不证明原生撤回；同步 RPC 问题和审批沿用其连接边界。

## 审批提醒与确认后换卡

审批通知使用原 account/binding/conversation/host/thread/turn 的参与者名单做原生 @，不会用显示名、当前选择或其他群的相同线程拼收件人。名单在该次请求通知时冻结，去重并排除 @all 等非个人身份；通知新建独立审批卡，不覆盖触发命令的旧卡。

显式允许、会话范围允许或允许规则只有收到 Codex confirmed 才产生 approval 展示边界；提交选择本身不换卡。拒绝、取消、拒绝网络规则、failed/withdrawn 或未知确认没有继续执行卡。批准后旧进展卡收尾为阶段小结，新 AI 卡承接同一原生 turn 的后续进展/答案，不调用 run/steer/queue/interrupt，也不修改原生任务状态。进展开启时，新卡承载成功提示，不额外再发一张成功通知卡；仅文字/关闭进展的渠道保留确认通知。

边界 ID 和确认事实在审批日志同一次原子保存中提交，再通知展示。可选 presentations 位于 v1 文件顶层，严格的原 v1 审批记录字段不变，旧版本回滚读取仍可忽略该投影。重启读取已确认展示事实，沿用现有 stream acceptedInputs 去重；不是保存权限或自动重新批准。实际 Bridge→原生 JSONL→明确审批命令→确认→两张执行卡的直接用例，同时核对只有一次任务执行和正确 @。

## 展示和秘密

### 审批通知投递与原生决定分离（本轮修复契约）

实际入口是 BridgeService.requestApproval → ChannelApprovalController → 渠道独立审批卡；用户决定交给原生后，reportApprovalResult 收到原生确认。当前缺口是确认事实写入后先删除通知上下文，投递失败便无法恢复。修复保留严格 v1 审批记录，在顶层增加可选的通知投影：原卡 ID、结果和投递状态。只重试更新已获回执的同一张审批卡；新文字通知回执不明时不能盲发第二条。通知失败不撤销已确认的原生决定，也不再次提交决定或启动任务。

初始审批卡发送失败保留原生待办，不把渠道故障变成拒绝决定。账号停止时退休通知重试和本地等待，不伪造允许或拒绝。恢复时核对原收件会话/host/thread，已换绑的通知不能送到新任务；重启只恢复原卡更新，继续执行卡仍由持久展示边界去重。

原生表单字段、dropdown 和按钮直接工作，不为内部枚举另造复制块。纯 IM 回复才给完整有效命令，各值独立。secret 字段用 password，提交后清空，不进 SQLite 事件或浏览器 storage。提交表示正在交接；原生确认之后才表示已答。没有请求身份不能拼一个“批准所有”替代原生选项。

native-async-questions、interaction-fanout、taskboard-native-integration、bridge-user-input、approval 及 elicitation 测试覆盖原请求/晚订阅/关闭 UI/秘密字段/提交失败等直接场景。真实钉钉供应商可见性与手机样式另外验收，不由接口测试冒充。

## 漏重放与完整快照

AppServerRequestMonitor只在实际订阅就绪后停止补订阅；原生状态waitingOnApproval但当前observer没有对应实际approval request时，仍需在原host/thread补订阅，不发用户输入、不猜审批答案。异步agent-message通知是增量，NativeAsyncQuestions默认合并；observeThreadInteractions仅把通过nativePage、active turn及items DTO校验的完整snapshot标为complete。可信空snapshot撤销消失且未提交的问题；非法snapshot、别的item增量不清空原待办，已提交的未知答案继续等待精确原生回执。INT-02.1/2有真实JSONL协议子进程反例。

INT-02.6：交互重放请求 itemsView=full；summary 可能同时省略问题和已接受答案，不能作为完整替换证据。对同一 item 的增量保留未提供的 questions 字段；完整撤回、明确替换和 accepted answer 仍关闭原待办。NativeAsyncQuestions.suspend、Peer 独立订阅和执行回调使用既有 suspended 结果，不新增协议枚举或默认决定。正常重连沿用原 Q 编号和卡片。

旧版误撤回的异步问题，只有当前原生再次明确提供同一个 account/binding/host/thread/turn/request/widget 及问题指纹、且从未记录答案摘要时，才恢复 pending 并发送一次标明“重新核对”的修正卡。同步请求、换绑、问题改写、已有或未知答案不复用旧内容。observationVersion=1 区分采用挂起语义的新记录；仅未标记 observationVersion 的旧策略记录才允许迁移。recoveredPending 在发修正卡前持久保存，一旦使用便不能被再次撤回、轮询、重连或 Gateway 重启重置。新策略下的真实 withdrawn 不自动重新开放。两个字段均为本地可选元信息，旧文件可读，回滚可忽略；不保存答案正文或授予提交权限。

观察者在答案回调等待中更换，只产生 suspended 并禁止旧回调写入；完整问题撤回和真正轮次结束仍为 withdrawn。native.async-question.result 沿用日志 major=1，只记录不含正文的 host、原生请求身份、结果及固定生命周期原因，不能把诊断输出作为原生回执。

NATIVE-02.9：问题持久状态为 pending 不等于存在有效内存 waiter。批量冷恢复读失败必须局限于专用只读连接，不能关闭其他会话的回答通道。恢复途中拒绝回答应准确说明“仍待回答、连接正在恢复、这条回答未提交”，不能谎称问题不存在。question.waiter 的 attached/released 只记录不含正文的生命周期；不是接受答案的原生回执。新增跨线程读失败/超限×本机/远端、只读能力限制、父清理及恢复提示用例；与 INT-02.6 的去重、完整视图和原卡策略共同约束。
