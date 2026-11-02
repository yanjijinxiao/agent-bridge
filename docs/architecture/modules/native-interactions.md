# 原生审批、问题与多消费者

AppServerRequestMonitor/Runner 观察原请求；InteractionRouting 选择仍有效 IM 来源。审批选项、提问字段、原 thread/turn/item/request ID 都属于原生请求。Bridge 只能展示并回传用户明确答案，不能因路线不存在、重启或 UI 关闭而生成默认允许/拒绝。

## 共享观察与退休

NativeInteractionFanout 每个 host/thread 保留一个底层观察者，按 gateway/taskboard 等消费者分发当前未决请求。晚订阅能获得原 pending 请求；第一份仍有效的明确答案才可提交。替换或移除消费者使其旧 promise 失效，不能注销另一个消费者。更新后的同 ID 请求不复用旧已解析答案。

Taskboard 通过观察消费者接入，不在 run 上安装抢占 IM 的 active handler。原请求回到表单后才允许再次选择；答案 flush 未知先观察，不自动再送旧决定。NativeAsyncQuestions 的通知微任务和最终写前均核来源；撤回、peer 已答、编辑、断连和 end 退休旧内容。

## 审批提醒与确认后换卡

审批通知使用原 account/binding/conversation/host/thread/turn 的参与者名单做原生 @，不会用显示名、当前选择或其他群的相同线程拼收件人。名单在该次请求通知时冻结，去重并排除 @all 等非个人身份；通知新建独立审批卡，不覆盖触发命令的旧卡。

显式允许、会话范围允许或允许规则只有收到 Codex confirmed 才产生 approval 展示边界；提交选择本身不换卡。拒绝、取消、拒绝网络规则、failed/withdrawn 或未知确认没有继续执行卡。批准后旧进展卡收尾为阶段小结，新 AI 卡承接同一原生 turn 的后续进展/答案，不调用 run/steer/queue/interrupt，也不修改原生任务状态。进展开启时，新卡承载成功提示，不额外再发一张成功通知卡；仅文字/关闭进展的渠道保留确认通知。

边界 ID 和确认事实在审批日志同一次原子保存中提交，再通知展示。可选 presentations 位于 v1 文件顶层，严格的原 v1 审批记录字段不变，旧版本回滚读取仍可忽略该投影。重启读取已确认展示事实，沿用现有 stream acceptedInputs 去重；不是保存权限或自动重新批准。实际 Bridge→原生 JSONL→明确审批命令→确认→两张执行卡的直接用例，同时核对只有一次任务执行和正确 @。

## 展示和秘密

原生表单字段、dropdown 和按钮直接工作，不为内部枚举另造复制块。纯 IM 回复才给完整有效命令，各值独立。secret 字段用 password，提交后清空，不进 SQLite 事件或浏览器 storage。提交表示正在交接；原生确认之后才表示已答。没有请求身份不能拼一个“批准所有”替代原生选项。

native-async-questions、interaction-fanout、taskboard-native-integration、bridge-user-input、approval 及 elicitation 测试覆盖原请求/晚订阅/关闭 UI/秘密字段/提交失败等直接场景。真实钉钉供应商可见性与手机样式另外验收，不由接口测试冒充。
