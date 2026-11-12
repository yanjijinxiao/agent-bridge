# 进展、卡片与渠道回执

DEL-08.13：旧输入接收扫描失败/超时不能禁止只读 provenance 修复。observe 总是允许该修复独立验证当前持有者及完整原生来源；原输入恢复仍控制结果副作用，repairQueueTerminals 和 closeDeliveredProgress 不因修复进展而放开。只有完整来源、活动 turn 和新鲜同 host/thread 绑定同时成立，才能校正被旧展示污染的完成记录。部分、终态或换绑证据不重新打开卡片，不发答案、不启动任务。

Connector 的完整来源扫描上限为 4 GiB，保留 15 秒读取预算及 50000 个 turn 上限；在 readline 累积前逐字节块检查单行不超过 64 MiB。超限、超时、缺尾、来源不是根会话或文件身份变化均返回未知，不用尾窗口冒充完整证明。本次约 2.77 GB 现存记录的只读验证与边界测试见[四层记录](../../audits/2026-11-12-follow-receipt-repair.md)，不据此承诺任意长度历史或机器负载下均能完成。

Herdr 源码中的终端观察复用 ChannelTurnPresentation，状态事实来自 RuntimeObservationController。blocked 是等待终端处理，不生成原生审批/聊天问答；idle/error/exited 是终端观察结果，不能变成“已完成任务”。中断控件按能力显示，只承诺请求；画面有界刷新、状态阶段保留，IDE 和 @ 沿用公共能力。回执未知不另建卡、不自动重发通知；见[运行模块](agent-runtime.md)与[增量四层检查](../../audits/2026-11-07-herdr-adapters/README.md)。

TurnPresentation/ThreadEventHub 保存按 host/thread/turn、阶段、卡片和页的展示状态。进展摘要、commentary、公开工具状态与最终答案分开，长任务持续刷新；原生 running/terminal 决定执行状态，渠道回执决定平台接收。Task 卡用普通字号状态与原生 loading，不额外附大标题冒充新答案。

进行中的公开 commentary 由 phase-progress 按阶段保留，工具/公开摘要只保留有界动态窗口。下一段 commentary 结束上一段的活动窗口，保留工具计数小结。长卡由 TurnPresentation 先保存新旧句柄和收尾意图，再沿相同任务开下一张卡；旧卡收尾失败不转移新卡结果，创建回执未知不授权重建。复制框与 IDE 页脚由原展示层管理。详情与边界见[阶段成果与实时活动](../phase-progress.md)。会话恢复通知使用独立标题，idle 不得把已失败轮次显示为“已完成”。

## 接收健康、输入恢复与当前进展

账号的接收连接 error 只说明渠道收消息异常，不代表会话解绑。AccountManager 在账号实例未被取消且仍有 client/store 时保留 running/starting/error 的订阅；明确停止、取消实例和解除绑定仍退出跟随。重连保留原卡及游标，不能将故障转换成“已停止同步”。CHAN-04.4 通过真实 monitor 回调验证 error→connecting→connected 和 stop 后迟到回调。

ThreadEventHub 将 inputRecoveryFailure 与当前快照 syncFailure 分开。旧输入核对失败后，已加载原生持有者的精确 activeTurn 可以更新当前进展；精确已结束轮次更新为“任务已结束，结果待同步”。不推进历史游标；纯文本或已具备精确输入权威的结果可独立收尾，缺证据的附件仍等待核对。IM `/follow` 状态和 Web 会话列表单独展示输入回执恢复诊断。核对成功后恢复原结果投递，重复同步不重复执行结果动作；绑定在等待期间改变时不得向旧对话写入。对应 DEL-08.7，详见[修复记录](../../audits/2026-11-03-main-review/fixes.md)。

## 一次投递的边界

创建、更新、分页和媒体各有回执。sendActionCard/sendTaskCard 的文本能力降级在 ChannelClient 第一次外部写入前选择。任何卡片写异常都不能授权 Bridge 再建卡或把同一正文发文字；partial delivery 只记录已经确认的页并报告剩余未知，不能从头发送。明确命令卡更新失败保留原表面，不推断用户没看见。钉钉适配器同样遵守这条边界：已配置卡片时，即便平台明确拒绝创建，也向上返回该失败，不改走 webhook；未配置卡片时才预先选择文本能力。卡片收件人只接受已确认的群聊或单聊类型，空值和未知类型不能按私聊猜测。

最终 @、复制控件和项目 IDE 页脚属于共享展示层。模型不重复拼 IDE 尾链；完整必要回复才可复制，路径、状态、目录树和原生按钮标签不变成复制答案。复制动作没有提交/授权副作用。围栏、分页、字节预算与 directed mention 分开测试，再检查合并边界。

原生完成回执中的纯文字结果没有附件副作用，不依赖旧队列输入的归属核对。AccountManager 在进入结果动作授权前先识别是否有动作；有动作仍保留原精确输入、轮次和投递日志校验。否则无关旧队列的历史读取失败会阻止已完成任务的原卡收尾。状态待确认的进度卡不提供通用 `/stop` 复制入口，因为该命令作用于聊天当前任务，不能把历史卡片当作仍可停止的目标。确认为活动的等待/恢复状态保留停止入口，确认完成后原卡显示最终正文。详见[旧队列阻塞终态修复](../../audits/2026-11-04-stale-terminal-card.md)。

## 渠道与网络

DingTalk/Feishu/Wecom/Weixin 适配器解释平台事件身份和业务回执；HTTP 成功不等于业务成功。入站 claim 失败不能 ack。附件类型/大小/总超时均在边界检查；网络重试受总预算约束，上传或发送阶段未知不以换 IPv4/IPv6 等方式重复业务写。typing 不等于消息交接，不锁 Gateway 重启。

control-card-delivery 新增四个原版失败场景，覆盖 action/goal form 的创建/更新未知；正常 text-only 路线仍由原 ChannelClient 测试保留。channel-write-leases、turn-presentation、DingTalk/progress、result-pages、copyable 及媒体 journal 测试覆盖各层。当前本机与平台 API 测试不能证明真实手机的每个像素或消息已经可见。

## 此次补测的联合边界

DEL-01.3由hub持有执行和结果投递两个事实；AccountSession.followStatus把同一结果投递状态投影到Web，IM沿formatFollowStatus展示。原生idle/完成但最终帧失败仍显示待投递；渠道确认接收不等于用户看见。DEL-07.3联合原生@、中文emoji及IDE页脚计算最终5999/6000/6001字节边界。DEL-08.3从rollout monitor经hub检查子agent/guardian的摘要、工具和假终态隔离；DEL-08.4检查真实accepted input才切段、最终@/IDE所有权、迟到重复终态不新开空卡。DEL-09.3对HTTPS和SDK各连续30次更新，再经过等待/恢复/重启/终态；这些仍是协议/投影验证，手机原生显示另验。CHAN-03.2/3核对DingTalk三路线文件原始字节与精确限额，及DingTalk、Feishu已支持image、WeChat三类媒体的上传成功但消息失败；不将不支持能力写成成功。

## 队列终态与原卡的联合验证

CTRL-03.3新增8项真实编排场景：三终态×有无新轮次，两次管理器重建后保留原卡和精确投递回执，不再次原生add/start，也不短暂标记为执行中。正常队列输入仍创建一张进展卡并最终投递一次；矛盾的原生运行态不能被旧送达回执当成结束。渠道传输和原生API是替身，实际AccountManager回调、Bridge、原生facade和Hub不替换。相关136项通过，没有复现业务回归；对象重建不等于真实Gateway进程骤停或手机显示验收，详见[联合记录](../../audits/2026-11-01-four-layer-recheck/2026-11-02-queue-delivery-integration.md)。

## 飞书与企微媒体端口

FeishuChannelAdapter与WeComChannelAdapter只组合渠道端口；FeishuMediaSender/WeComMediaSender处理各自原生上传与发送，readOutboundMedia共用单文件描述符的有界读取，拒绝空文件/非普通文件/超限及读取期间变化。Feishu图片10MiB、文件与视频30MiB；企微按已安装官方SDK的100×512KiB协议预算限制。现有文本、卡片、更新、提问、历史和结果动作入口保持共用ChannelClient。

飞书普通文件使用stream上传及file消息，MP4视频使用mp4上传及media消息；不填虚构时长/封面。chat_id、open_id、user_id由同一feishuRecipientType决定，避免媒体与文本/卡片各自猜测收件人。默认SDK工厂为每账号包一层HTTP响应校验：先确认上传原始code为0，再允许SDK解码data为image_key/file_key；不修改全局Axios拦截器。这样非零code即使含有效形状key也不能被解码掩盖。注入的已解码SDK测试端口与raw响应分别校验，最终仍要求消息的code:0和非空message_id。

企微调用官方SDK的uploadMedia与sendMediaMessage；前者保留原type/filename/bytes，结果type和media_id都必须匹配，后者独立要求errcode:0与关联headers.req_id。SDK按upload_id/chunk_index重试分片，不重试整个消息发送。原始WebSocket断连会拒绝pending消息，不在Gateway中据此重发。消息/群类型只按chattype解释：single回复from.userid；group缺失chatid在持久认领前拒绝；未知种类不从chatid猜群。群成员userid可记录为结构化来源身份，目前不因此宣称已支持原生@。

Bridge仍以显式send动作触发；TurnResultActions在外部I/O前持久认领，确认后才done，未知结果跨重启保留started，不重复上传/发送。缺SDK媒体方法时不宣称available，也不把本地路径作为已送达文字。远程文件仍先通过原执行主机回传端口成为Gateway私有副本。

钉钉文件和卡片共用已确认的持久收件路由。活动入站优先使用该消息的 AsyncLocalStorage/webhook；重启时先恢复原消息仍有效的私有回复凭据，只有没有可用凭据时，才由同账户 clientId 限定的 card-routing.json 恢复精确群 ID 或员工 ID，沿原生主动发送接口投递。主动私聊发送另受平台 OTO 权限限制，不能把有员工 ID 当成已获平台许可。现有文件上传/发送回执和不重试未知写入的规则不变。

私有回复凭据复用已有 ChannelMessage.contextToken → 转发记录 → RuntimeStateStore（0600）→ 渠道投递链路。dingtalk-reply-context 只接受有界、未过期、同 clientId 和精确 conversationId 的结构，webhook 只允许 HTTPS 的 oapi.dingtalk.com/robot/sendBySession；无效凭据不使用。凭据不进入模型、公开 card-routing、知识或日志。公开路由不保存 webhook、token 或正文，也不能从 cid 前缀猜群、把加密 sender 当员工 ID，或借其他机器人记录发送。CHAN-03.9 的 13 个直接测试覆盖持久恢复、Bridge 不向模型泄露凭据、文件与文本回复及错误作用域；探探真实 SIGKILL 验证原任务持续、原卡完成且文件送达。真实群聊和过期 webhook 下平台主动发送权限仍须独立验收。

验证使用实际飞书SDK对隔离HTTP的multipart/业务码与实际企微SDK对隔离WebSocket的init/chunk/finish/send，外加真实Bridge/动作日志；未连接真实账号。平台权限、企业安全策略、视频播放及手机呈现仍待实机验收。协议依据：[飞书消息内容](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json?lang=zh-CN)、[文件上传](https://open.feishu.cn/document/server-docs/im-v1/file/create)、[企微官方SDK](https://github.com/WecomTeam/aibot-node-sdk)。
## 微信二维码回执

创建/轮询 QR 的显式非零 ret 先于状态字段检查；错误响应中的旧二维码、connected 或 redirect_host 不得发布账号或改变轮询目的地。旧成功 GET 响应缺省 ret 仍兼容。失败只展示安全数字码，不把原始 errmsg 输出给用户；QR 自身到期仍优先终止轮询。CHAN-04.5 验证真实登录类与替身 HTTP 回执，不代表实际扫码验收。


## 企微入站内容

WeComChannelAdapter订阅SDK的text/image/mixed/file/video/voice事件；统一核验消息ID、操作者和群ID，引用保存为独立资料。voice只包含平台转写，不能伪装成已下载音频。factory透传现有inboundDir/大小配置；Bridge通过原准入链路后才调用resolveAttachments。

wecom-inbound使用有总时限与密文字节上限的fetchWithBudget，再调用官方SDK的AES解密；验证明文大小、保存0600随机私有文件，解析安全文件名。下载凭据从已解析附件移除，不进入错误日志；第二个附件失败或磁盘部分写入失败会清理本次创建的文件，整条输入失败，不能只提交剩余文字。CHAN-03.10为官方解密+受控传输/事件的精确用例。原生@仍未确认长连接接口合同，不以webhook参数或普通@文字代替；实际企微账号/手机另验。

## 退役记忆与附件日志兼容

结果只执行附件副作用。旧 remember 字段忽略且不阻止同块合法附件；纯旧 remember 结果和纯文本一样直接收尾，不等待无关队列归属查询。TurnResultActions 使用稳定附件身份，并识别旧序号中 0–3 条记忆动作产生的偏移。新发送同时保留旧格式散列别名以兼容代码回滚；started 表示未知，不重发，done 表示已确认。详情及验证边界见[移除记录](../../audits/2026-11-04-remove-gateway-memory.md)。

## 当前轮次附件与旧回执的隔离

AccountManager.nativeResultAuthority 按账号/绑定/session/host/thread/turn/收件对话核验现有接收回执，精确匹配成功后跳过无关的旧队列查询。ThreadEventHub.resultReady 只解决历史核对失败时的精确结果可投递性，实际动作仍经过 applyNativeResult、绑定租约和 TurnResultActions。来源未知不意味着任务仍在运行；展示等待结果状态，保留 sourceText 直至动作校验及处理成功。sourceText 是内部待投递原文，绝不能直接经过渠道 Markdown 输出。迁移字段均可选，旧已准备好的纯正文待投递记录仍按原格式恢复。

24 项定向用例覆盖阶段格式、原卡收尾、附件与旧回执组合、错误 host 拒绝授权、重启、轮次切换和重复完成。源文件逐段检查及静态/配置范围见[此次四层记录](../../audits/2026-11-05-terminal-progress-regression.md)。

## 钉钉短流式状态与完整快照

ChannelProgressLayout 保留正文与操作区边界。activeDingTalkLayout 为 HTTPS/SDK/初始创建共享的两区投影：完整状态、阶段与实时活动以普通更新写 staticMsgContent；停止/IDE 页脚以短流式帧写 contentKey。前者为静态组件，后者为流式组件，字段读回不能证明后者已经显示。changedDingTalkCardFields 比较已确认静态字段，progressControlFrames 独立记录流式页脚回执；正文更新不重发页脚或布局元数据。创建后首帧必须初始化页脚；失败、重连、等待恢复不能错误跳过。终态关闭流式再写静态全文。模板与持久化格式不变。

DEL-09.6 补齐停止控件重复的更新过程约束、链接真实变更、失败重试及适配器重建，见[回归记录](../../audits/2026-11-06-stable-progress-controls.md)。

DEL-09.7：activeDingTalkLayout 在流式页脚的独立末段显示可信的运行/恢复状态，使原生加载光标与 IDE 链接、复制框分离；该段不随工具活动变化，不进入复制值或等待/终态正文。预算检查包含新增段落且先于任何 API 写入。沿用双组件，不把长正文迁回流式接口。见[位置回归记录](../../audits/2026-11-06-loading-position.md)。

2026-11-09 Herdr 最新展示策略：[终端窗口](terminal-presentation.md) 替换单卡正文，按实际渠道容量保留最新尾部，不进入阶段累积/命令摘要/续卡。状态和 IDE/复制控件独立保留，结束时原卡收尾。Codex 原生阶段策略不变。

## 关闭过程回复与接收事实

/stream off 依既有契约只发送最终结果，不创建进行中的 AI 卡。会话未设置时继承全局配置，不能把不显示卡片误诊为 Connector 离线或输入未提交。钉钉“思考中”表情属于消息处理生命周期，不能作为原生接受/执行/结束事实；排查以精确 clientUserMessageId/host/thread/turn 回执与结果投递为准。2026-11-12 探探截图的 review 已接收并产生原生输出，全局 streamReplies=false 是没有过程卡的配置原因；另一 Herdr 观察流的 runtime 错误与它分开归因。现场只读核对元数据，没有重发任务或变更该用户的展示设置。
