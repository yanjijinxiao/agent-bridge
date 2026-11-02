# 进展、卡片与渠道回执

TurnPresentation/ThreadEventHub 保存按 host/thread/turn、阶段、卡片和页的展示状态。进展摘要、commentary、公开工具状态与最终答案分开，长任务持续刷新；原生 running/terminal 决定执行状态，渠道回执决定平台接收。Task 卡用普通字号状态与原生 loading，不额外附大标题冒充新答案。

## 一次投递的边界

创建、更新、分页和媒体各有回执。sendActionCard/sendTaskCard 的文本能力降级在 ChannelClient 第一次外部写入前选择。任何卡片写异常都不能授权 Bridge 再建卡或把同一正文发文字；partial delivery 只记录已经确认的页并报告剩余未知，不能从头发送。明确命令卡更新失败保留原表面，不推断用户没看见。

最终 @、复制控件和项目 IDE 页脚属于共享展示层。模型不重复拼 IDE 尾链；完整必要回复才可复制，路径、状态、目录树和原生按钮标签不变成复制答案。复制动作没有提交/授权副作用。围栏、分页、字节预算与 directed mention 分开测试，再检查合并边界。

## 渠道与网络

DingTalk/Feishu/Wecom/Weixin 适配器解释平台事件身份和业务回执；HTTP 成功不等于业务成功。入站 claim 失败不能 ack。附件类型/大小/总超时均在边界检查；网络重试受总预算约束，上传或发送阶段未知不以换 IPv4/IPv6 等方式重复业务写。typing 不等于消息交接，不锁 Gateway 重启。

control-card-delivery 新增四个原版失败场景，覆盖 action/goal form 的创建/更新未知；正常 text-only 路线仍由原 ChannelClient 测试保留。channel-write-leases、turn-presentation、DingTalk/progress、result-pages、copyable 及媒体 journal 测试覆盖各层。当前本机与平台 API 测试不能证明真实手机的每个像素或消息已经可见。
