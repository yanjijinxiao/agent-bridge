# 首条原生队列输入的渠道规则修复

本轮基线 main a069427094081593f380a55989ad8841ece1e5ae。范围是此前明确剩余缺陷 NATIVE-02.7；不是再次宣称全库逐行检查完成。此前历史故障矩阵及未测边界继续有效。

## 原因与修复

Bridge 的 /queue 入口调用 buildPromptParts 后只取 prompt，丢弃 developerInstructions。原生 queue/add 可立即消费，并不接受 turn/start.additionalContext；在 runQueuedSubmission 观察阶段再准备规则已经太迟。

入队前复用 prepareTurnSubmission，把渠道规则、当前账号知识、Peer 文件目录约束及正文作为同一个原生 queue input 保存。只提交一次 queue/add；Gateway journal 仍只存来源和回执，恢复只核对同一原生输入。原生权限和模型设置不变，未增加 thread/injectItems、占位 turn/start、备用执行器或重放。Gateway 历史和预览由既有 parsePrompt 剥离规则；Codex 原始历史可能保留前缀，明确作为原生字段限制下的兼容边界。

## 四层核对

1. 架构：规则必须在自动消费前交接；Gateway 仅保存回执，执行、恢复、投递仍按原生身份拆分。普通消息 additionalContext 路径不改变。
2. 模块和异常：复用附件转存与 Peer 目录约束，原绑定/准入/角色写前 guard 保留；未知回执不重试 add。断连重载 Connector 的设备日志后规则不丢、原输入只消费一次。
3. 文件/函数：逐段检查 enqueueNativeMessage、recoverNativeQueue、共享 prepareTurnSubmission、原生队列协调器与 facade、前缀构造/剥离以及新增断言。AST 比对基线证明 service 仅 enqueueNativeMessage 方法体改变；其他方法只更新行号/文件散列，未伪称重新逐行读完。具体范围在 read-ledger.jsonl。
4. 静态/配置：构建成功，同一制品预置并切换探探 Gateway、Linux Connector、本机 Mac Connector；核对工作目录、制品散列、独立核心存活。无权限配置修改，无生产头头或 Codex 重启。原先 Peer IDE/公开入口缺口保持未完成。

## 验证

- 旧实现隔离副本：同一个实际 Bridge→原生模型用例在“模型请求含渠道规则”断言失败；已排除早期测试夹具未驱动恢复 tick 的超时，不把该超时当产品失败证据。
- 新增四个首条队列测试：DingTalk、WeChat、Feishu、WeCom。检查实际模型正文、一次 queue/add、一个原生用户输入、权限前后一致、干净预览、回执日志不保存重放正文。入队后清空账号知识再恢复，实际输入仍保留入队时知识快照。
- 扩展真实 Connector 测试：先有活动轮次，排队后断开连接并重载设备服务；检查持久队列及第二次模型请求中的渠道和文件规则，来源 ID 只出现一次、恢复后原轮次完成。
- 完整根回归 3033 项：3032 通过、1 项 Windows 专用跳过，已启用原生核心和 Chrome。Connector 测试随后改为调用共享 prepareTurnSubmission 并单独重跑通过，四渠道知识快照断言也单独重跑通过；最终证据覆盖当前散列。类型检查、Bridge 构建通过。Taskboard 未改，本轮不重复执行，旧证据明确 inherited。
- 探探真实 Linux CLI 核心：新建无历史会话，第一条消息直接 /queue；用户测试正文仅要求创建并发送文件，不提供 actions 格式。19:08:17 收到文件消息与完成回复。原生 rollout 有 1 条环境说明、1 条业务输入、1 个开始/完成轮次及 1 条文件动作；业务输入含 DingTalk 和 Connector 文件规则。输出文件内容与测试标记一致。

## 状态和限制

NATIVE-02.7 在上述明确边界内 verified。功能清单仍为 378 项：272 verified、106 partial；检查器无错误。这不代表所有历史问题、所有真实渠道或手机端显示已经验收。

已被旧版本接收的队列项不重写、不补发；本次修复从新入队生效。真实平台只测探探钉钉，其他三渠道为真实原生核心加隔离渠道适配。钉钉消息回执未提供可下载 resource ID，因此未做手机打开/下载或下载后哈希验收。Peer 完整 Web IDE/Taskboard、手机入口、Windows 等仍按已有待办保留。

证据：test-results.jsonl（历史未变证据加本轮新结果，最后一次为准）、validation-summary.json（运行/实机脱敏摘要）、inventory.jsonl、read-ledger.jsonl。原始运行日志、账号和凭据不入库。旧已知失败测试保留为“观察阶段注入无效”的历史反例，当前产品 case 已映射到实际 Bridge 入口测试。
