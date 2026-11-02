# 绑定、主入口与个人准入

绑定是一条 account/conversation → session → host/thread 的关系。项目名称、cwd、个人 actor ID 都不能替代该关系。session-execution、session-follow、interaction-routing、RuntimeStateStore 和 AccountManager 共同使用这条明确边，交互主入口只是仍有效绑定的引用。

## 两类身份与授权

ChannelMessage.senderId 是平台确认的操作者，replyTargetId 是当前对话；群内准入根据个人，投递根据群。viewer 可查询，participant 可提交正常输入和允许的控制，controller 管理对应绑定/更高权限控制。每次异步准备结束和外部写入前重新核对来源、运行代次、角色及准入，包含 A→B→A。

管理 UI 的新建 session 只能选择实际观察到的会话边或已验证的最近回复路线。DingTalk/Feishu/Wecom 的 pairedSenderIds 是个人准入清单，不补成群候选；只有 Weixin 直接聊天传输可以把联系人作为对话。两个候选不自动暗选，选项展示完整账号/对话身份。

## 状态转换

明确 unbind/leave 持久退休选择并停止跟随，不删除原生任务。项目切换只保留兼容边；不能让旧选择复活。已接收的原生写入属于旧线程事实；之后来源变化仅退休旧展示，不能伪称未提交或反向改动原生状态。原生 projectMembership 的 assigned、none、unknown 分开，unknown 不扩大访问权。新绑定把它保存为 projectBinding=unknown，重载不自动补项目；继续原线程省略项目提示，也不传显式移除 none。后续权威 assigned/none 才更新关联。

## case

binding-expiry、session-source、full-review-controls、goal-response-source、runtime-default-response-source、web-bindings 和 full-review-web-races 验证撤权、换绑、旧控件、明确目标和迟到回执。完整 case 名及还缺的设备组合见 BIND/AUTH/CTRL 清单。不能用有界本机替身证明远端供应商已经接受消息。
