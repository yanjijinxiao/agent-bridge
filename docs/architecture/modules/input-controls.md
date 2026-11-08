# 普通输入、队列与明确控制

BridgeService 只把已注册内置/扩展斜杠命令送入控制分发。未注册命令先作简短文字提示，再按普通输入处理；已注册命令的参数错误或能力不足不能透传。分类不替代准入、角色或原目标核验，见 IN-01.slash-forwarding。自然语言、引用内命令和附件归原生会话。channel-commands 给出统一命令注册和角色要求；session-control 串行化真实控制交接，不能串行等待整轮执行。普通运行中消息默认 steer，显式 queue 使用原生持久队列。

## 来源和接收

prepareTurnSubmission 形成单一应用输入，远端附件先转存，TurnSubmission 捕获来源日志并分别保存 submitting/accepted。连接、下载、目录读取之后到最终请求之前继续检查 assertCurrent。明确未提交的准备拒绝可重试；已经尝试但回执未知的输入不自动再发。显式消息合并区另存 collecting/preparing/submitting，done 不是再次授权重放未知旧内容。

### 原生队列的规则交接（NATIVE-02.7）

queue/add 可以立即自动消费；queue/start/恢复观察不能补充已经执行的规则。当前原生 queue/add 只接受 input，没有 turn/start 的 additionalContext。因此 Bridge 在入队前复用 prepareTurnSubmission，连同渠道规则、入队时的知识和 Peer 文件目录约束，把完整输入一次提交到原生持久队列。原生队列是这份输入的唯一持久执行来源，Gateway 的 queue journal 仍只保存来源和回执。

这是原生字段限制下的明确兼容方式：队列 input 采用已有 buildPrompt/parsePrompt 的规则前缀格式，Gateway 历史和预览剥离规则，只显示用户内容；Codex 原始历史可能保留该前缀。普通 turn/start 继续使用独立 application context。规则没有原生 sandbox/approval 配置写入，不使用 thread/injectItems，不新建占位轮次，也不在未知提交后重复 add 或补发任务。恢复时使用已入队的原内容，不按当前渠道、知识或配置重写旧输入；已消费的历史旧项无法追补，不伪称修复。

模型、effort 和计划模式的唯一事实源是原生会话。显式选择通过同一 Connector 和原生 `thread/settings/update` 更新后续轮次，收到匹配的 `thread/settings/updated` 后才报告生效；只提交本次修改，不启动占位任务，不改全局 config，不修改正在执行轮次。Gateway 不持久化执行覆盖值，普通续聊和重启不重新应用旧值。旧 state 中的 model/effort/collaborationMode 退休时直接移除，不能迁移成一次原生写入，以免覆盖桌面中更新的设置。

`/model default`、`/effort default` 兼容旧命令，仅刷新并说明当前已统一使用 Codex 会话设置；不再维护独立的“继承开关”。未创建原生线程的会话须先创建原生空线程并保存精确身份，再修改设置；创建或设置回执未知时不自动重试。写入前重新检查来源和绑定；原生不支持设置接口时明确报错，不退回本地保存。状态查询轻读原生模型/effort，不以缓存或 Gateway 配置冒充当前值；原生只读接口不提供计划模式时显示未知，切换命令从原生 resume 的完整设置计算。

目标 get/set/clear 和表单见 goal-controls；原生目标状态不创建新执行器。停止、队列删除、答案及审批均保留明确身份，不把“最新轮次”代替用户原来的精确目标。

## case 和失败归属

full-review-controls、runtime-default-response-source、prompt-buffer、native-queue、turn-submission 以及 inbound receipt 相关测试分别检查最终 guard、正文、排队和持久恢复。命令拒绝、原生执行失败、投递失败有不同错误类型；不能用同一个 catch 清空去重或把已生效操作标为未提交。

CTRL-03.3的queue-delivery-integration沿真实NativeQueueCoordinator、Bridge、原生facade、AccountManager、Hub与磁盘日志联合核对。已送达的旧结果但队列回执尚未结算时，三种终态×有无新轮次都不能标active、建新卡或替换新卡；两次管理器重建后仍只读结算原输入。原生仍运行的矛盾快照不结算，正常pending项仍有进展及一次最终结果。原生API和渠道传输为替身，不证明真实accept/fsync间骤停；具体[记录](../../audits/2026-11-01-four-layer-recheck/2026-11-02-queue-delivery-integration.md)保留partial。

2026-11-03 追加验证：native-queue-crash-recovery 在独立真实原生核心旁启动实际 Gateway 子进程，六种 pending/running/离线完成、队列回执 rename 前后及恢复再崩溃场景联合断言原生输入、结果、当时的记忆动作各一次（记忆移除后该断言改为附件字节与发送次数）与 inbox 清理。使用真实五秒恢复调度，IM 传输和模型仍为隔离端口。native-queue-concurrency 的两客户端各追加两项，正常/写入端断连/执行端也断连三种组合，按原生队列的实际顺序检查完整消费，不以客户端时间推断顺序。

该测试还发现 Hub 先于队列恢复看到完成时可能漏掉附件。AccountManager.applyNativeResult 现在先核对同账号、对话、host/thread 的缺 turn 队列来源，再决定结果动作权限；读取失败则本次投递暂缓，不提前把结果标成已完成。核对仅更新来源事实，不重发输入。结果动作仍经原动作日志去重，等待后核对账号实例与绑定；其他线程不加入这次观察。queue-result-recovery 为正常、读取失败后恢复、账号退休、不同 turn 四种时序提供确定性对照。供应商丢 ack 的所有窗口及手机卡片呈现仍未验收。

全回归进一步捕获 queue auto-consume 的跨读取矛盾：runtime 已 active，但分页历史暂时只有终态。Hub 原来先 reconcile，再报告缺可信活动轮次，可能已经发送“任务已停止”并把真实结果去重掉。observe 现在在任何结果/卡片修复之前检查 active 与对应 inProgress 轮次是否一致；矛盾只更新跟随健康状态，保留原卡与绑定，后续一致快照再继续。CTRL-03.5 增加六种终态×有无 active ID 的反例与恢复对照，不以改文案代替状态顺序修复。

同一故障也可能从陈旧 idle 快照开始。AppServerCodexRunner.readThreadSnapshot 因此在分页历史返回后，沿同一连接再次轻读 owner 状态，再合成快照和判断漏通知终态；新增 idle/active→新活动轮次两种读取顺序测试。多一次轻量 metadata 读取是明确代价，不扫描完整历史，也不创建/切换执行器。

队列执行完成和结果送达分开结算。Bridge 从 Hub 取得真实 boolean 投递回执；NativeQueueCoordinator 只在确认送达后写 delivered。未送达保留 completed + lifecycleVersion 2，下一次只观察原 turn，不再 queue/start。原生失败/中断也通过同一 Hub 完成日志确认，迟到回执不新建卡。兼容原有不返回值的隔离调用者；真实 Bridge 显式返回确认值。只有未知外部交接才进入 deliveryUnconfirmed，不把可证明的未送达误当作需要重跑任务。

原生历史明确返回 completedAt=null 时，终态标签不构成结束回执；最新轮次如此则本次快照暂缓，旧的此类历史项从有限观察窗口排除，不据此结算。真正带结束时间的停止/完成仍正常处理，较旧服务省略字段保持兼容。该检查发生在本地等待者与 Hub 结算之前，防止历史读时尚未结束、状态读时已空闲的交错。
