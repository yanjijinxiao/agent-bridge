# DingTalk 引用正文调查与解析补充

用户截图中引用预览可见，模型却要求重新粘贴。本次按已接收消息的精确 ID，用当前用户 dws 的 messages-mget 查询找到该回复及完整引用；再用 message list-by-ids 查询回复和原消息，确认两者正文一致、聊天范围匹配。未复制业务正文、群标识、员工信息、凭据或下载链接到仓库，也未发送测试消息。

这证明原文可以通过本次用户查询恢复，不能据此证明机器人 Stream 回调也提供了同样的正文。原回复已不在转发 inbox；raw 回调原本就不持久保存。本地引用缓存只有已处理输入，原消息未命中。因缺乏当时的原回调，不能确定该截图是上游正文缺失还是某个字段漏解析。此前把解码为空表述为“仅收到引用元信息”缺少证据，已改成“尚未取得可读的引用正文或附件下载凭据”，并说明可以按原消息 ID 核对。

## 四层检查范围

1. 架构：渠道拥有平台格式解析；共享层在准入后解析引用、下载附件并复核来源。原文引用与本轮命令分开。此次不新增执行链、权限、状态 schema 或个人身份后台查询。DingTalk driver 的自动引用补查仍未实现，个人 dws 查询不能冒充这一能力。
2. 模块与异常：对照 Stream → decodeDingTalkInbound → ChannelMessage → 同聊天引用缓存 → referenceContext；检查卡片/富文本/JSON/未知格式、当前正文和引用斜杠隔离、凭据不进模型、深度/节点/长度预算。旧共享层测试继续验证跨群隔离、缓存重载、授权前不读附件及远端转存。
3. 文件与函数：完整重读修改后的 dingtalk-inbound.ts，核对 record/string、media 闭包、引用递归和总附件限额；新增 cardText 只读取 elementType、TEXT.value、children。相邻只读范围为 dingtalk.monitor 的接收与投影、InboundReferenceStore 全文件、BridgeService 的准入/resolveReferences 和 promptItemsFromMessage 片段、ForwardingInbox.normalize、共享 client.resolveReferences 默认实现。没有声称全仓逐行复核。
4. 静态与配置：新增纯解码反例文件及 Stream 适配器组合测试，同步功能合同、模块、session 索引、需求 case 与函数记录。不修改生产配置、账户、凭据、发行号或已发布制品。

## 独立复现与验证

上游第一手[卡片回调样本](https://github.com/soimy/openclaw-channel-dingtalk/issues/598)展示 content.cardContent 中的 TEXT.value；[钉钉维护的实现](https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector/blob/main/src/core/message-handler.ts)兼容旧 richText.richTextList。这两种形态可在当前旧代码独立复现正文漏失，但不能当作本次截图的原始报文。

新增九项纯解码测试在修改前五项失败、四项通过：两种卡片对象/JSON、直接/引用旧富文本和缺失措辞失败；已有富文本对照、预算拒绝和文本/链接兼容通过。修复后九项及新增一项真实 Stream 适配器组合测试通过。卡片正文保持内联文本和段落边界，预算超限不发布部分正文；动作、任意 metadata 和 downloadCode 不混入模型引用。Stream 网络是替身，适配器解码、命令分离和投影使用真实代码。

定向运行 dingtalk-quoted-content、inbound-references、dingtalk、dingtalk-inbound-ack 四个测试文件：120 项通过，0 失败、0 跳过；类型检查通过。本调查阶段未运行全库回归，后续发行阶段的完整回归另行留证；未在群里发测试卡，未重启 Gateway 或 Connector；调查结束时修复尚未发行；后续已完成 [0.6.2 npm / GitHub 正式发行](2026-11-10-v062-release.md)，生产实例未在本次发布中重启升级。日志和散列见[结构化证据](2026-11-10-dingtalk-quotes.json)。

## 尚存边界

- 缺正文的引用不会自动用个人 dws 补全；自动方案需要机器人可用的原文接口及身份/聊天范围合同，不能把个人查询能力推广给所有使用者。
- 本地缓存不保证命中别人未发给机器人的原消息、过期或已淘汰消息。
- 卡片含未适配元素、仅有附件 ID/文件名或平台不透明正文时，不能声称已读取原文/文件。此次没有实现任意卡片渲染器、平台密文解密或附件凭据补取。
