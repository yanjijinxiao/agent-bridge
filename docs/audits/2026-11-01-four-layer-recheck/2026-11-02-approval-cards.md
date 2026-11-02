# 审批 @ 与确认后新 AI 卡

用户新增要求：审批消息 @ 人，批准成功后创建新的 AI 卡。实际路径是 Bridge requestApproval → ChannelApprovalController → ChannelClient 原生 mentions；明确 approve → native confirmed → 审批journal展示事实 → presentAcceptedInput/ThreadEventHub → ChannelTurnPresentation 新段。不是提交新任务或改权限。

在原参与者名单上取 @，不猜当前群成员或显示名；审批通知独立新卡，不改触发命令的旧卡。只对明确允许且获原生确认的决定换卡；拒绝/取消/拒绝网络规则/失败/撤回不建立继续执行段。成功由新进展卡承载，不额外重复发成功卡，关闭进展仍有确认。

同文件原子保存 confirmed 和可选顶层 presentations，旧v1严格行不变；重开恢复同边界ID，由既有stream去重。记录不是原生权限凭证或可重放输入。真实Bridge/原生JSONL夹具验证run只有1次，执行卡2张，mentions只原发起人，旧卡阶段收尾、新卡持有后续结果。直接63项通过；阶段全量2538通过1平台跳过。为保旧版回滚读取，后续调整投影布局后上述直接例再次全部通过，最终发布prepare会复验全部代码。

初次参数化fixture误把未声明的session/cancel选项当作可选，等待正常超时；已改为显式原生选项，原生协议/权限代码没有因此放宽，失败日志保留在私有临时目录。没有向真实群发送测试消息，手机端可见性不伪装成已验。
