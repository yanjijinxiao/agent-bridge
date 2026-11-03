# 进展、卡片与渠道回执

TurnPresentation/ThreadEventHub 保存按 host/thread/turn、阶段、卡片和页的展示状态。进展摘要、commentary、公开工具状态与最终答案分开，长任务持续刷新；原生 running/terminal 决定执行状态，渠道回执决定平台接收。Task 卡用普通字号状态与原生 loading，不额外附大标题冒充新答案。

## 接收健康、输入恢复与当前进展

账号的接收连接 error 只说明渠道收消息异常，不代表会话解绑。AccountManager 在账号实例未被取消且仍有 client/store 时保留 running/starting/error 的订阅；明确停止、取消实例和解除绑定仍退出跟随。重连保留原卡及游标，不能将故障转换成“已停止同步”。CHAN-04.4 通过真实 monitor 回调验证 error→connecting→connected 和 stop 后迟到回调。

ThreadEventHub 将 inputRecoveryFailure 与当前快照 syncFailure 分开。旧输入核对失败后，仅已加载原生持有者的精确 activeTurn 可以更新当前进展；不推进历史游标，不执行最终动作、补投或确认恢复回执。IM `/follow` 状态和 Web 会话列表单独展示输入回执恢复诊断。核对成功后恢复原结果投递，重复同步不重复执行结果动作；绑定在等待期间改变时不得向旧对话写入。对应 DEL-08.7，详见[修复记录](../../audits/2026-11-03-main-review/fixes.md)。

## 一次投递的边界

创建、更新、分页和媒体各有回执。sendActionCard/sendTaskCard 的文本能力降级在 ChannelClient 第一次外部写入前选择。任何卡片写异常都不能授权 Bridge 再建卡或把同一正文发文字；partial delivery 只记录已经确认的页并报告剩余未知，不能从头发送。明确命令卡更新失败保留原表面，不推断用户没看见。

最终 @、复制控件和项目 IDE 页脚属于共享展示层。模型不重复拼 IDE 尾链；完整必要回复才可复制，路径、状态、目录树和原生按钮标签不变成复制答案。复制动作没有提交/授权副作用。围栏、分页、字节预算与 directed mention 分开测试，再检查合并边界。

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

验证使用实际飞书SDK对隔离HTTP的multipart/业务码与实际企微SDK对隔离WebSocket的init/chunk/finish/send，外加真实Bridge/动作日志；未连接真实账号。平台权限、企业安全策略、视频播放及手机呈现仍待实机验收。协议依据：[飞书消息内容](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json?lang=zh-CN)、[文件上传](https://open.feishu.cn/document/server-docs/im-v1/file/create)、[企微官方SDK](https://github.com/WecomTeam/aibot-node-sdk)。
