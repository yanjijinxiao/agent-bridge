# 探探真实环境验证（2026-11-03，Asia/Shanghai）

## 环境和制品

最初探探 Gateway 在 29 的 `peer-fix-2f4280e`，不是本轮 main。先在无账号临时实例完成启动检查，再将 Gateway、Linux Connector 和新装 Mac Connector 同步到 main fe2df3d，随后按实际发现的缺陷逐次验证修复。没有接管头头、停止用户任务或更改全局原生权限。

首次完整验证制品 `tantan-regression-final.tgz`，2090009 字节，SHA-256 `126ac32bdae496620c57af65b85e5b2fe30441a27d2c4e3211407f1fb2130279`。该轮三端 `regression-final` 目录来自同一制品；Linux 依赖沿用同一锁文件的已安装依赖，平台原生核心分别是 Linux 0.163.0 和 Mac 0.166.0。证书验证保持开启，没有 NODE_TLS_REJECT_UNAUTHORIZED=0 或临时取消准入。

| 组件 | 本轮最终状态 | 生命周期核对 |
| --- | --- | --- |
| 29 探探 Gateway | tantan-gateway-test，regression-verified，PID 78116；发布控制 prepared:false | 仅这个测试 Gateway 被 SIGKILL/切换，原状态保留 |
| 12 Linux Connector | linux12-codex-connector-20261102，regression-verified | 原生 daemon/core PID 9955、10115 全程保留 |
| 新装 Mac Connector | com.codex-channel-bridge.connector.tantan-mac，LaunchAgent，regression-verified；PID 46530 | 独立设备 xking-mac-regression/profile desktop、独立状态目录，复用同一个原生核心 |
| Mac 头头生产服务 | 原 Gateway PID 70562、原生 PID 11238/1272 | 未切换、未重启 |

末次又补齐无模板 @ 命令首帧与后续分页的凭据透传（独立反例修复前失败，相关 111 项通过），最终根回归 3029 项、3028 通过、1 Windows 跳过。最终制品 tantan-regression-verified.tgz，2090037 字节，SHA-256 f43e057ca50465073efe3a2def5a371eff43e646513d672068a89aa8eda3a25e。三端运行目录和 app-server-runner.js 摘要相同，Gateway 的 dingtalk.js 也与构建一致。Mac 第一次立即 bootstrap 返回 I/O 错误；确认旧服务已退出、配置和目标文件有效后重新注册成功，已连接探探。

新装 Connector 的配置/CA/设备凭据保存在本机私有目录；LaunchAgent RunAtLoad + KeepAlive 持续运行。未将凭据或历史附件原文复制入仓库。旧测试容器和制品保留回退；本轮无账号 smoke 容器已清理。

## 从旧 case 到实际失败

### 1. 续接线程缺少渠道规则

Mac 专用会话最初可以正常读文件和回文本，写文件按原生 read-only/user 要求审批。批准后原任务完成，但模型两次给出不符合 `send` 数组约定的文件动作。原生 rollout 中没有 Bridge 规则。

旧夹具把 thread/resume 的 developerInstructions 参数直接保存，掩盖了真实原生核心对已加载线程不更新该字段的事实；已订阅线程直接 thread/read 同样遗漏规则。本轮用实际原生核心和本机假模型检查真正发送给模型的请求，四种创建/续接路径及第二轮规则更新均有直接断言。

修复后保留线程原规则和权限，新建用创建规则，续接通过 turn/start 的 application context。Mac 实际文件回执 `msgeIFLMDditPQu1t5MNniNKw==`，原卡 `msgGNdy/ddAs4H91JHihgZktg==` 最终完成。Linux 同样能正确生成文件动作。

### 2. Gateway 恢复了任务和卡片，却没有恢复文件回复能力

专用 Linux 会话 `01a1a0d2-e34b-7000-8c3a-e76c6ab2e50a` 执行一次命令：写 START、sleep 60、写 DONE、回传结果文件。只有观察到 START 且尚无 DONE 后才 SIGKILL 探探 Gateway，不停止 Linux Connector 或原生核心，不再次提交输入。

| 实测轮次 | 原生任务/卡片 | 文件结果 |
| --- | --- | --- |
| 原实现 | 原任务完成、标记各一次、原卡完成 | 18:12:38 报“钉钉文件接收会话未知”；msg47UDtXz6e+o8UMGOusH6gw== |
| 仅补持久公开路由 | 原任务仍完成 | 18:17:37 平台拒绝主动私聊，chatbotId.notAllow.sendOTO；msg8Umtka1LOxK+oYN3oDrz9A== |
| 同时恢复原消息有效私有 contextToken | 原任务持续、同一组核心 PID，START/DONE 各一次；原生 rollout 中该用户输入仅一次 | 18:25:01 文件成功，msg0fJ4J6lzOvym6c0Kp48gPg==；原卡 msgHM4GZnwJaLt0IlFEklw3TQ== 显示完成 |

最终成功文件为 linux-restart-context-20261103.txt，源文件 57 字节。这个机器人实际没有可用的主动 OTO 路线，因此公开路由恢复的测试通过还不够；必须恢复原会话仍有效的回复凭据。凭据复用已有私有 contextToken 流程，不进入模型、公开 routing 或日志。过期后仍依赖平台已授予的主动发送能力，不能保证永久回传。

DWS 实际查询得到文件消息，但未提供可下载 resource ID。没有声称已经下载钉钉副本并比对哈希；源字节、动作日志和平台文件消息是各自独立证据。真实群聊、手机显示未代验。

### 3. 原生队列历史与持有者状态不同步

完整回归第二轮出现一次 queue/observe communication error，没有删掉失败或直接以重跑通过结案。追加诊断捕获 RPC：同一轮次的 thread/turns/list 已是 completed/interrupted，而已订阅持有者仍 active/inProgress；adoptQueuedTurn 误转只读恢复，然后因 active 状态抛错。

修复前 40 次诊断中有两次相同观察失败、三次 5 秒 initialize 超时。两个确定性 JSONL 反例修复前均失败。修复后保留本订阅精确 active turn 的观察，两个反例及相关 52 项通过；40 次真实原生重复运行全部通过。诊断启动预算改为 15 秒以分离启动负载和观察竞态，不能把该结果描述成 5 秒启动超时也已修复。

最终探探真实 `/queue` 回执 msgnGZ26z+rIa1H2L5iqULzbA==，原卡 msgSodpccC3F5Nuq5Qnb+r2tg== 最终显示 QUEUE-FINAL-20261103。原生 rollout 中用户输入只出现一次；没有再次 start、重发或中断。

## 审批、断连和续卡

Mac 测试会话 `01a1a0c8-c837-7ac0-adb4-f79159f2bf78` 的 read-only/user 来自新建原生会话默认值。本轮没有为了绕过审批修改它，也没有覆盖用户其他会话设置。

- A9 在 17:44:19 送达；等待超过两分钟，于 17:46:43 终止本轮新装 Connector 进程，原生核心保留。恢复后 A9 撤回，新 A10 于 17:46:48 送达。
- 实际发送旧 `/approve A9`，被拒绝，文件尚不存在；批准 A10 后写入只一次。旧编号拒绝消息 msgNXk45egA/f1CC2o4APS8Vw==，新批准回执 msge6nPN9V9gpX5sDTUDj+i1g==，完成消息 msgSFFK7zRf+QOlWjEAx1yM8w==。
- A9/A10 时未启用流式卡，因此另补 A11 正式验证。18:37:55 原生审批消息 msgk8AgYw0MOW4qtGL4ug55JA==；只批准一次，不保存长期规则。
- 18:39:05 原卡 msgF4yWWCFqwVwJpmDyJ2FpQw== 转入后续卡片，创建不同 ID 的新卡 msgDzhf0OssxB7tvDw41qKNuw==，最终显示 MAC-CARD-DONE-20261103；文件 msgkG1ZMO+7YOysv4Pn3hKg6Q== 送达，源文件只含一次标记。

以上是私聊中正式原生审批链路，不代表真实多人群 @ 通知、手机复制控件或所有并发答复组合已验收。

## 收尾与仍未完成的范围

测试后探探恢复到原 Linux 会话 `01a19b25-5fa7-7333-b4d1-5d553936898e`、host peer:linux12:headless、cwd /home/admin/gateway-connector-linux-test/workspace。专用测试会话及合成文件保留作为复核材料，没有删除旧未知交接记录或重发它们。本轮监听停止，原共享事件服务保留。

29 的资源服务 publicOrigin 仍是 http://127.0.0.1:28479，TLS 前端只代理 Peer WebSocket；这是手机外部访问的部署缺口。Peer 当前文本工作区不等同于完整 code-server/终端/Git/Taskboard 集成。不能用本轮私聊文件成功或无项目会话没有 IDE 页脚，推定项目 IDE 功能已完整实机验收。

实际消息发送和读取使用 dws skill（本机 /Users/xking/.agents/skills/dws/SKILL.md）对应工具。仓库外原始日志保存在本机受限测试目录，仓库只存脱敏摘要、可比对源码/测试及证据散列。

## 独立确认但未修复的失败 case

NATIVE-02.7：空会话首条原生排队输入不包含 Bridge 规则。实际核心只调用模型一次，但请求中没有给 runQueuedSubmission 的 developerInstructions；原生 0.166.0 experimental schema 中 queue/add 仅接收 threadId/clientUserMessageId/input，queue/start 仅接收 threadId/queuedSubmissionId。自动消费不会经过 turn/start.additionalContext。失败测试单列保存并实际运行失败；没有计入普通根回归成功，也没有用修改原权限、伪造任务或重发绕开。需要单独补原生队列上下文交接及其恢复语义。
