# 实验 Connector 的接口与边界

Peer 是默认关闭、显式配置的部署适配层。Gateway 仍使用 CodexBridgeBackend；机器人渠道和远端设备两侧不各自实现一套会话、卡片或审批业务。Connector 主动连接 Gateway，只执行设备本机确认的 profile/thread 和资源授权。

执行采用原生最终写前 guard：同步来源检查保留不变，跨机额外等待 beforeWrite 回查原 Gateway 来源；该能力通过 writeGuard: 1 协商。旧 Connector 不得静默执行新 Gateway 的写请求。来源失效与已提交但回执未知是不同事实，不能为了重试互相转换。

运行内回调和独立交互订阅均复用原生 handler、fanout、request monitor 与渠道 controller。订阅按 consumer 管理，不能拿 gateway consumer 的健康状态代替 peer consumer。断线退休观察和 UI，保留原生待审请求；不会合成允许或拒绝，也不会中止独立 daemon 的任务。

文件统一使用 fetchOutputFile/OutputFileLease，Peer 在公共端口上补充 account/conversation/thread scope；SSH 与 Peer 传输实现不同，投递和临时副本清理共用。共享文本工作区使用 IDEAuthorization 的浏览器证明和持久授权，资源到期是期限上限，始终不开放终端或全功能 code-server。

当前支持范围、未开放接口和验证事实见 [2026-11-03 修复矩阵](../../audits/2026-11-03-peer-contract-review/fixes.md)。原生 queue、自动恢复、skills/MCP 目录及动态工具等尚未开放，不能把本模块视为 NATIVE 全契约已验收。通用新建/命名/归档行为仍作用于支持该能力的 local/SSH 后端，不由 Peer 开关隔离。
