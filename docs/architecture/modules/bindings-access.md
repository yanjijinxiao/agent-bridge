# 绑定、主入口与个人准入

当前 Connector 的个人目录偏好与群绑定独立，命令、持久化和验证合同见 [connector-selection.md](connector-selection.md)。保存设备选择不构成资源授权。

绑定是一条 account/conversation → session → host/thread 的关系。项目名称、cwd、个人 actor ID 都不能替代该关系。session-execution、session-follow、interaction-routing、RuntimeStateStore 和 AccountManager 共同使用这条明确边，交互主入口只是仍有效绑定的引用。

## 两类身份与授权

ChannelMessage.senderId 是平台确认的操作者，replyTargetId 是当前对话；群内准入根据个人，投递根据群。viewer 可查询，participant 可提交正常输入和允许的控制，controller 管理对应绑定/更高权限控制。每次异步准备结束和外部写入前重新核对来源、运行代次、角色及准入，包含 A→B→A。

管理 UI 的新建 session 只能选择实际观察到的会话边或已验证的最近回复路线。DingTalk/Feishu/Wecom 的 pairedSenderIds 是个人准入清单，不补成群候选；只有 Weixin 直接聊天传输可以把联系人作为对话。两个候选不自动暗选，选项展示完整账号/对话身份。

探探的组织准入范围现为 MaxCompute 及下属部门，取代仅 SQL 引擎的部署名单。通讯录按正式父部门及逐层子部门展开，按 userId 字符串原值去重，保留前导零和字母前缀；搜索结果或部门概览人数不能代替成员 ID。通过既有 allowSender 管理入口增加个人准入，不新增第二套部门 ACL，不改管理员、群授权、会话角色或 Connector grants。当前是人工同步的名单快照，人员变动不自动生效；撤销沿用 removeSender 及原浏览器撤权机制。组织范围是探探的部署策略，不推广为头头或其他部署的默认权限。

## 状态转换

明确 unbind/leave 持久退休选择并停止跟随，不删除原生任务。项目切换只保留兼容边；不能让旧选择复活。已接收的原生写入属于旧线程事实；之后来源变化仅退休旧展示，不能伪称未提交或反向改动原生状态。原生 projectMembership 的 assigned、none、unknown 分开，unknown 不扩大访问权。新绑定把它保存为 projectBinding=unknown，重载不自动补项目；继续原线程省略项目提示，也不传显式移除 none。后续权威 assigned/none 才更新关联。

## IM 权限展示范围（2026-11-04）

本轮先改权限展示范围。身份来自已核验的平台消息，不接收命令文本提供的 actor/chat 替代值。/connect 继续只列 accountId + conversationId + actorId 精确匹配的设备授权；配对前仅提供配对指引，不列所有在线设备。设备授权代表可访问范围，不声称设备所有权。

/access 默认显示本人在当前聊天的准入状态及授权来源。普通用户只看自己的当前聊天申请；明确登记的准入管理员可以同时查看当前聊天的申请。/access all 是显式的同渠道账号管理入口，仅允许管理员在私聊调用；返回的详情与决定命令必须带 --all，且后续请求仍须来自管理员私聊。群里不能通过复制申请 ID、旧卡片、决定参数或 --all 读取、批准其他聊天的申请。管理员私聊普通 /access 也不自动列出全部申请。

查询、详情和决定复用同一范围判断；本机管理 UI 保留原有全局管理能力。个人准入、整群准入、准入管理员资格、会话角色、Connector 授权和浏览器授权各自有原有权威，不因展示范围收窄新增或撤销授权。展示 IDE 资格时使用原有个人浏览器准入事实；群授权和普通配置准入不能被展示成已有浏览器授权。

## Web 入口的权限边界

- Gateway 管理 UI：仅监听 127.0.0.1，校验 Host，写操作校验 Origin 和页面请求凭据。它是本机管理员控制台，没有按钉钉用户隔离的多用户登录；页面凭据不能冒充个人身份。不通过普通 IM 准入开放这个控制台。
- 项目 Web IDE：个人模式由独立访问服务校验准入、项目/主机/目录范围及浏览器授权；显式启用的持链接模式按 IDE-14 交换精确项目凭据，不冒充钉钉个人。HTTP 和 WebSocket 均校验；已有授权有效期仍为 90 天，撤销与停用继续生效。
- Connector 共享编辑器：会话所有者明确授予目录和读写范围，浏览器确认绑定用户及聊天，撤销/过期在实际读写时再次核对。
- 会话输入、审批/停止、历史和文件：先检查渠道准入与会话角色，再检查目标 host/thread 或文件目录范围。Codex 原生工具审批和沙箱仍由原生执行器负责。

本轮不把本机管理 UI 改成多用户门户，不扩大已有 ACL，也不增加 Connector 安装入口。对应验证和未验证范围见 docs/audits/2026-11-04-permission-visibility/README.md。

## case

binding-expiry、session-source、full-review-controls、goal-response-source、runtime-default-response-source、web-bindings 和 full-review-web-races 验证撤权、换绑、旧控件、明确目标和迟到回执。完整 case 名及还缺的设备组合见 BIND/AUTH/CTRL 清单。不能用有界本机替身证明远端供应商已经接受消息。
