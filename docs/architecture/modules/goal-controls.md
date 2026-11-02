# 原生目标控制与响应归属

本说明覆盖 Bridge 的 /goal 入口、原生目标接口及返回结果的展示归属。停止、模型、强度和其他控制另见 CTRL 系列 case，不能从本模块的通过场景推断全部控制已验证。

## 功能和权限

| 用户操作 | 实际动作 | 最低角色 |
| --- | --- | --- |
| /goal | getGoal 读取已绑定线程；无目标时给设置表单 | viewer |
| /goal form、new 或 set（无正文） | 给原生目标表单，尚未写目标 | participant |
| /goal set 加正文 | setGoal 指定 objective 与 active | participant |
| /goal pause、resume、complete | setGoal 指定 paused、active、complete | participant |
| /goal clear | clearGoal 清除选定线程目标 | participant |

输入必须经过现有准入与角色判定。查询可保留 viewer 权限，修改前使用相同规则；不能因为补来源守卫而提升只读查询所需权限。表单提交会明确生成 set 语法，控制词作为正文的独立 payload case 仍在 CTRL-04.2 待补，不能用表单格式测试代替实际接口断言。

## 接口和职责

入口为 src/bridge/service.ts 的 handleGoalCommand，角色规则来自 src/bridge/access.ts 的 requiredCommandRole。executionSession 决定具体 session，sessionHostId 决定原生主机。所有 get/set/clear 调用显式传原 threadId 与 host，不因查询失败切到本机。

目标实体由原生 App Server 保存。Gateway 不建立本地目标副本，也不通过“设置目标”新建一个执行器或新一轮任务。src/codex/app-server-runner.ts 的 getGoal、setGoal、clearGoal 分别调用 thread/goal/get、thread/goal/set、thread/goal/clear；修改在 ensureConnected 完成后、实际请求前再调用 assertCurrent。

replyGoalCard 将原生目标变成渠道卡片；没有目标时提供表单。回复回执仅代表该次展示处理，不能替代目标在原生服务的事实。

## 关键时序

1. 捕获原 session/host/thread、执行代次、actor 和最低角色，生成 controlGuard。
2. 修改前先核 guard；原生后端连接等待后再次核 guard，阻止尚未发出的旧控制。查询也在开始前复核来源。
3. 原生操作返回成功后，在展示前重新核验同一个来源。换绑、同 ID 切走再切回、撤销个人准入、修改权限不足或渠道停止，均让旧展示退休。
4. 已返回成功的修改属于原线程事实。展示退休时正常结束 dispatch，来源回执为 handled；不抛“控制操作未提交”，不自动重发或执行反向修改。
5. 原生请求失败照原路径上报；本次只在得到正常响应后抑制过期展示，不捕获实际 RPC 错误或渠道发送失败冒充成功。

Bridge 对展示的复核发生在调用渠道发送之前；消息已经进入供应商传输后无法撤回的窗口、实际客户端如何显示，仍需另行验收。

## 直接 case 与边界

CTRL-04.4 的 test/goal-response-source.test.ts 运行真实 Bridge、角色/绑定状态和 InboundReceiptJournal，原生接口及渠道使用替身。4种操作 × 6种来源状态：原来源不变、换线程、ABA、降为viewer、撤销个人准入、停止渠道，共24项。

测试先让原生动作发生并确认、延迟其返回，再改变来源；断言只调用原 host/thread 一次、过期结果零发送、重开来源日志为 handled 且不可重放。正常4种操作均有回复；只读查询降为 viewer 仍允许。原版24项中5个正常对照通过、19个过期展示反例失败，修复后均通过。首轮夹具曾把允许的 viewer 查询也算作应禁止，已依据真实角色规则纠正并重新保留原版失败证据。

提交前撤权由 full-review-controls.test.ts 另验证，断言实际原生修改零调用。不能把“写前拒绝”和“成功后的展示失效”合并成同一种错误。

这不是实际远端服务、手机卡片或所有目标状态的端到端验收。模型/强度继承的迟到查询、控制词正文 payload、目标状态新增值及所有原生失败组合继续保留待验。
