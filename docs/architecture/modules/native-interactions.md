# 原生审批、问题与多消费者

AppServerRequestMonitor/Runner 观察原请求；InteractionRouting 选择仍有效 IM 来源。审批选项、提问字段、原 thread/turn/item/request ID 都属于原生请求。Bridge 只能展示并回传用户明确答案，不能因路线不存在、重启或 UI 关闭而生成默认允许/拒绝。

## 共享观察与退休

NativeInteractionFanout 每个 host/thread 保留一个底层观察者，按 gateway/taskboard 等消费者分发当前未决请求。晚订阅能获得原 pending 请求；第一份仍有效的明确答案才可提交。替换或移除消费者使其旧 promise 失效，不能注销另一个消费者。更新后的同 ID 请求不复用旧已解析答案。

Taskboard 通过观察消费者接入，不在 run 上安装抢占 IM 的 active handler。原请求回到表单后才允许再次选择；答案 flush 未知先观察，不自动再送旧决定。NativeAsyncQuestions 的通知微任务和最终写前均核来源；撤回、peer 已答、编辑、断连和 end 退休旧内容。

## 展示和秘密

原生表单字段、dropdown 和按钮直接工作，不为内部枚举另造复制块。纯 IM 回复才给完整有效命令，各值独立。secret 字段用 password，提交后清空，不进 SQLite 事件或浏览器 storage。提交表示正在交接；原生确认之后才表示已答。没有请求身份不能拼一个“批准所有”替代原生选项。

native-async-questions、interaction-fanout、taskboard-native-integration、bridge-user-input、approval 及 elicitation 测试覆盖原请求/晚订阅/关闭 UI/秘密字段/提交失败等直接场景。真实钉钉供应商可见性与手机样式另外验收，不由接口测试冒充。
