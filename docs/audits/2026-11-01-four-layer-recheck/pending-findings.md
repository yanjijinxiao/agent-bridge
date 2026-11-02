# 待复现与待验收项（进行中）

这里记录阅读产生的疑点，防止上下文切换后漏项。除注明已有失败证据外，均不是已确认缺陷；逐项需要实际调用路径、隔离反例和正常对照。不能据此批量改代码或改断言。

1. 原生队列 idle：一次全量出现 queue/observe 未确认，后续单独、12 次并发隔离及另一轮全量均通过。保留原日志；尚无根因。后续报告器保留失败调用栈以定位真正分支。
2. Taskboard 旧 UI/样式/流程六项中，附件/宽度/聚焦的四项已读实际组件并通过真实 Chrome 验证，确认是旧断言过时，已更新。仍有两项 WorkflowBoard/moveWorkflowNode 断言待读全真实流程并验证，未直接改正则。
3. Taskboard 渠道：ensureProject/getIssue等待后降权/解绑/ABA仍写入，六个原版反例确认；本地补每请求来源guard到实际fetch前与本地bind/workflow前，只允许己方同步绑定推进lease。21个来源/正常/late-ack/文件读取场景通过，Gateway全量2419通过1跳过。首次全量三个旧in-memory测试替身缺新增withWriteGuard接口，已补替身契约而保留原业务断言；原失败保留。请求ID仍仅内存，未知写失败释放或重启重复写尚未解决，workflow更多分支仍待场景。
4. Taskboard 评论部分上传：submitComment 先创建评论，inline 图片 Promise.all 失败后保留原草稿；普通附件失败又清空暂存区。需验证是否重复创建评论、遗失可重试文件，以及旧任务响应是否更新新任务详情。App 的 TaskDetail 实际使用 task.id key，已排除单纯本地 setState 串到另一任务组件的猜测；父级回调仍待核对。同任务评论提交等待中later edits被旧成功清空已有真实Chrome反例，已本地按草稿revision保留，未编辑正常清理作为对照；部分上传另待核。
5. 原生项目与 Desktop 别名：codex-projects.ts 按主目录排除 native ID，resolveProjectId 按 cwd 翻译未知 ID、创建仅传主根。需明确完整 rootPaths、同目录多 native 项目、旧 Desktop 别名与真正原生 ID 的关系及迁移；不能简单删兼容路径，也不能把 UI 元数据当执行身份。
6. 项目 unknown：ManagedSession 只支持显式 none；新绑定的原生项目归属 unknown 是否被错误记为 none，且不能继续准确展示/核验 IDE 范围，需要实际绑定反例。
7. 控制响应归属：goal get/set/clear 以及恢复模型/强度继承后的异步查询，迟到结果可能按新的绑定展示；原生修改已完成后不能再伪称“未提交”。需分别验证查询丢弃旧显示、已接收写入保留回执。
8. 显式及普通输入异步准备转向：已有隔离失败证据，四种下载/转存/状态等待加三种引用解析均可转向新线程。已本地修复并补 14 个反例/对照；当前完整 Gateway 回归 2354 项通过、1 项 Windows 专用跳过；同线程 Taskboard 展示不当失效的本轮回归也已修正并保留正常用例。原输入的“明确未提交”分类还需检查，避免因 handleCommand 过早标记 submitting 而把准备拒绝写成回执未知；不能把 Taskboard 已产生外部副作用的命令一概重置为 received。
9. 审批/提问：Service.requestApproval 的 setActivity await 后两项失效反例已复现并修复：换绑/停止不发旧审批，保留无绑定项目通知路线。相同 requestUserInput 场景原本已在底层eligibility正确拦住，作为正常对照；两者未合成决定。其他角色/原生问题更新路线仍待验。
10. 重启边界：onTurnStarted 等待跟随/卡片准备后才释放部分 accepted 标记；需区分真正卡片传输与只读订阅等待。CapacityRecovery checking/settling、SystemRecovery pending 和命令查询等待的保护粒度仍需逐路径验证，不能直接删除保护。
11. 容量恢复：Service 传入的前置 assertCurrent 只检查 session/thread/host；需核对执行代次、准入/角色以及全局恢复协调器的补充检查。已排队原生输入优先与 systemError 清理是否有互相等待，需要精确反例。
12. 结果投递：replyActionCard/replyTaskCard 的更新失败会尝试新卡，发送失败会发文字。需回读“不追加文本兜底”的历史决策，确认适用范围是流式答案还是所有卡片，再验证未知结果不会重复投递。
13. 媒体动作日志的done误报已按40项实际复现并本地修复；远端无回传能力仍明确通知且不标已回传。媒体失败反馈中原始异常文本的隐私边界还需具体复核，不能因本次回执修复宣称全部路径安全。
14. 历史格式：本轮已保护围栏/引用的附件字面例子；含反引号的真实文件名/路径、首行缩进代码及没有 Bridge 前缀的私有知识字面块，仍待验证，不能因修例子误伤真实附件。
15. 状态 map 的原型键、坏记录与迁移歧义、共享控制 journal 的独立嵌入实例写入所有权（生产 AccountManager 已确认只创建共享单例，排除生产多账号各自覆盖的猜测）、微信缺少稳定 message_id 的重投身份，均需具体反例；只读代码推断不足以证明漏洞。
16. 安装/更新：npm 更新仍原地替换，Windows cmd 路径转义、超时子进程清理、官方 code-server digest 独立核验尚未完成。未在本轮真实执行安装、更新、重启或发布。
17. 展示验收：最新截图旧卡额外“已完成”摘要、最终 @ 新卡、IDE 页脚与可复制控件之间的关系，仍需按最新契约验证；本机 Chrome 或源码通过均不代替真实钉钉和手机可达性。

18. 发布恢复：真实release-local main隔离反例确认rollback恢复旧制品却留下持久门禁，已本地修复恢复后的新PID/token同owner解锁；四条正常/失败对照及相关31项通过。真实发布进程崩溃/手工恢复仍需另验，不把所有等待提示归因于此，未触碰线上journal。
19. Web 附件 saveSessionUploads 使用默认 writeFileSync 权限而非已用于微信入站的私有 0600；需核对管理上传目录真实 mode 和本机多用户边界，再决定是否修复。
20. 本地 rollout 观察旁路：生产仍读取 JSONL 的进展/完成，和标准 App Server liveFollow 的去重、父子继承及历史不能当新消息的边界需补核；单条 JSONL 长记录无大小上限，watcher timeout 的 scanNow 拒绝未 catch。

21. Web 对话设置栏仍使用 bootstrap 的本机模型目录和全局 runtime，远端模型/推理强度展示与实际执行主机一致性待验证；IM 查询的 HOST-01 修复不等于此 Web 场景已覆盖。
22. Web 个人 actor 准入 ID 被加入新建 session 的 conversation 候选，且 authorizedConversationId 最后回退 pairedSenderIds[0]；需验证群渠道不能拿 actor ID 当群目标。已有歧义 picker 测试只要求不暗选，没有证明候选身份类型全部正确。
23. Web 知识库保存没有 pending 锁，回车重复提交或保存期间修改字段的行为待验；旧 Taskboard 评论 handler late reload 不应覆盖新详情，但它并非当前 iframe 主界面入口。

24. WorkflowBoard 整文件及 canonical control-flow 已读完：仅 parentId 内部计划项 draggable=true，root/condition 被禁用，UI 不调用仍存在的 moveWorkflowNode。两项失败涉及整棵条件子树移动，不能按另外四项的旧正则误报处理；需实际浏览器反例并核对是否为有意取消的功能，再决定修复。
25. 工作流 persistence：VERSION_CONFLICT 时直接 applyWorkspace(latest) 可能丢掉尚未保存的本地修改；capability await 仅靠AbortSignal而无源代次。需测试实际编辑/冲突/切换，不直接加泛化锁或业务重试。

26. 自动处理器额度等待中撤销/变更policy仍启动旧worker已实际复现，五个变更场景本地修复、正常对照保留，相关13项通过。UI静态模型矩阵和自有CLI执行生命周期与Gateway原生统一协议仍待整体核对。
27. 完整读ai-chat-process并核对UI后，排除“界面只读实际可写”的误判：read-only是保留内部枚举，实际文案是“请求批准”，workspace-write是“替我审批”。两者实际sandbox相同、reviewer不同，不能按旧字段名更改实际权限。自有exec是否支持人工审批往返及统一原生接口仍是独立待核验项。

28. Taskboard本地/cloud同缩写prefix项目撞号已四反例复现，本地SQLite/D1同事务分配global namespace，本地修复保留原identifier/version，相关28项通过。
29. 真实SQLite复现旧status constraint迁移丢creator/assignee/workflow，已本地修复copy与迁移顺序；原版legacy失败/current通过，修复后两例及全量旧API迁移通过，未接触生产数据库。

30. 云端Worker遗漏GatewayClient使用的threadId筛选(400)及transition(404)已真实客户端反例确认并补齐，状态与评论同D1事务，四新例和相关27项通过；R2删除失败/代理未知写与完整body预算仍待反例。

31. Taskboard App本体已逐行读完：saveEditor、duplicate、restore及undo完成后不核对原project，可能把旧项目数据插入新列表；inline上传失败时已创建issue但保留草稿，再试可能重复创建。与comment相同职责需要实际浏览器失败/正常对照。
32. App reconcileProjectAutomation会把localStorage旧policy再次apply，需核对其他页面关闭后是否被自动重新启用；本轮未开启任何实际自动化。
33. 真实local HTTP与D1 Worker复现非法日期被接受，真实Chrome卡片RangeError崩溃。已本地统一日历校验、旧异常值可见不崩溃；非法create/PATCH不变更、闰年/普通日期/null与浏览器正常对照通过，未改生产数据。
34. TaskContextMenu标点键及IssuePicker pending重复Enter均已真实Chrome复现：旧版window error、同选择调用2次。已本地改固定selector匹配和choose入口同步single-flight，正常S精确状态及失败后显式重试对照保留；相关40项通过，不借此自动重发未知HTTP写。
35. 主App基线就用SHOW_WORKFLOW_BOARD_ENTRY=false隐藏节点模式，历史公开用户文字没有找到明确的节点移动决定；不能把两个失败测试静默改绿，也不能用测试里的旧期望擅自恢复整个入口。保留实际功能意图核验。

36. 独立injector仍通过私有Desktop automation RPC和单独额度server运行；这是统一协议范围实际缺口，已明确登记不隐藏。额度helper的stdin EPIPE宿主崩溃已真实复现并本地修复，其他CDP JSON/late composer/同名项目label优先ID候选待具体反例。
37. 一次性云迁移把worktree_path先清空，再用worktree_branch是否非null决定类型；无branch的合法worktree丢类型已由真实SQLite→包写盘重读→D1→Worker API反例确认并本地修复：先保存context type再剥路径，18项迁移通过；旧包无法猜回已丢信息。实际Miniflare事务成功后丢回执反例确认自动删除已提交记录需要的R2，已本地修复attempted/confirmed分离；未知保留附件并原包只读verify，17迁移例通过。旧原子回滚断言保留但不凭adapter失败自动删R2；未动真实云端数据。
38. 捆绑周报integration reference残留其他机器/账号硬编码默认值；本轮仅作为静态数据阅读，不能直接用作当前用户的路径、收件人或授权。需先核对skill是示例模板还是应迁移的用户功能，再做准确文案修正。

39. AiChat真实Chrome复现坏UTF8 skill链接使整个面板消失及FileReader新对话混入旧附件，已本地修复，正常合法skill/原草稿保留对照，13项浏览器与25项UI通过。明确create/turn拒绝丢草稿已Chrome复现，本地改为确认接收后按代次/revision/线程清理；提交single-flight、切history/newconversation后迟到回执不抢selection，相关44项通过。未知写接收、换项目/晚error及loading归属仍须独立场景，不宣称完整异步来源已解决。

40. 真实Bridge媒体失败（丢回执、unsupported、remote无转存）被动作journal记done已3反例复现并本地修复；首次修复误把已确认发送的observer异常判失败，追加正常回执对照后隔离观察回调。新5例及Gateway全量2390通过、1Windows跳过；unknown仍保留started不重放，不改原生任务成功事实。

41. 原生NativeAsyncQuestions的通知微任务和steer连接等待后缺最终source guard：撤销observer/撤回widget/end/disconnect仍写旧答案，微任务前撤回仍发旧问题，5原版失败已复现并本地修复。增加peer/edited与正常对照；相关65通过，最终Gateway全量2398通过、1Windows专用跳过。追加edited测试夹具曾把旧已答promise用于新题，已纠正且保留该失败日志。

基线文件未读0；其余尚未映射场景和尚未验收设备，以需求清单的testGap与review-conclusions.md为准。此页不代表全部审查发现，也不是完整自检结论。

后续发布：初次审查快照763cddd已push并实际上线，钉钉重连、3个IDE端点及14份浏览器授权保留，原生执行器PID不变。本段后三个UI修复继续按独立发布验收记录，不把本地通过当已部署。
