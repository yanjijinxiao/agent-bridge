# 普通输入、队列与明确控制

BridgeService 只把显式斜杠命令送入控制分发。自然语言、引用内命令和附件归原生会话。channel-commands 给出统一命令注册和角色要求；session-control 串行化真实控制交接，不能串行等待整轮执行。普通运行中消息默认 steer，显式 queue 使用原生持久队列。

## 来源和接收

prepareTurnSubmission 形成单一应用输入，远端附件先转存，TurnSubmission 捕获来源日志并分别保存 submitting/accepted。连接、下载、目录读取之后到最终请求之前继续检查 assertCurrent。明确未提交的准备拒绝可重试；已经尝试但回执未知的输入不自动再发。显式消息合并区另存 collecting/preparing/submitting，done 不是再次授权重放未知旧内容。

模型/effort 的 default 先保存继承意图，再只读查询当前原生值。查询后来源退休不撤销已保存设置。目标 get/set/clear 和表单见 goal-controls；原生目标状态不创建新执行器。停止、队列删除、答案及审批均保留明确身份，不把“最新轮次”代替用户原来的精确目标。

## case 和失败归属

full-review-controls、runtime-default-response-source、prompt-buffer、native-queue、turn-submission 以及 inbound receipt 相关测试分别检查最终 guard、正文、排队和持久恢复。命令拒绝、原生执行失败、投递失败有不同错误类型；不能用同一个 catch 清空去重或把已生效操作标为未提交。

CTRL-03.3的queue-delivery-integration沿真实NativeQueueCoordinator、Bridge、原生facade、AccountManager、Hub与磁盘日志联合核对。已送达的旧结果但队列回执尚未结算时，三种终态×有无新轮次都不能标active、建新卡或替换新卡；两次管理器重建后仍只读结算原输入。原生仍运行的矛盾快照不结算，正常pending项仍有进展及一次最终结果。原生API和渠道传输为替身，不证明真实accept/fsync间骤停；具体[记录](../../audits/2026-11-01-four-layer-recheck/2026-11-02-queue-delivery-integration.md)保留partial。
