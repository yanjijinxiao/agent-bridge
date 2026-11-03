# 单一原生协议与核心所有权

Gateway 的业务端口是 src/codex/backend.ts。CodexAppServerGateway 负责 host 路由与连接角色；AppServerCodexRunner 负责原生请求、通知与精确线程/轮次；daemon/remote-host/transport 只解决服务部署和连接。桌面和纯 CLI 的业务方法相同。自定义可执行文件名不决定是否创建私有核心。

## 事实源和生命周期

原生核心保存线程、队列、目标、执行权限和运行事实。Gateway 的主连接、元数据读连接、大历史读连接指向同一核心；读端口超时可以退休自身，但不停止执行核心。显式 stdio 是宿主拥有的私有连接，退出宿主会结束它，不具有独立 daemon 的重启保证。嵌入 Taskboard 借用 AccountManager 的原适配器，close 不拥有核心；独立 Taskboard 创建一个选定适配器，不启动 exec 回退。

普通续聊省略 nativeSettings 并继承已有 sandbox、审批策略和 reviewer。只有拥有设置的 UI 明确提交 nativeSettings 才覆盖。onApproval 回调存在不构成改权限的理由。thread/start/resume 的返回身份、turn/start 的接收、运行终态与投递状态分开；有界 RPC 超时不能结束一个已接收的长任务。

Bridge 的渠道规则与原生执行权限也分开。新线程通过 thread/start 的 developerInstructions 设置创建规则；续接已有线程时，用 turn/start.additionalContext 中稳定的 codex-im-gateway application 项传入本轮规则。不能假定 thread/resume.developerInstructions 会更新已加载线程，也不能因为已经订阅、改走 thread/read 就漏掉规则。每轮规则更新不替换原线程的 developer instructions 或权限，不混入用户输入/会话标题。Mac 0.166 与 Linux 0.163 均提供该原生实验字段；初始化须启用 experimentalApi。

## 调用边界

新输入在最终写前调用 assertCurrent；续聊身份必须与 thread/read/resume 相同。onTurnStarted 持久接收身份以后，公共 item 才可更新该运行。停止必须使用精确 thread/turn；本地 close 只退休观察。runQueuedSubmission 用已保存原生回执核对，不带 prompt 重放。metadataOnly/historyOnly 连接有方法白名单，不能借只读身份写入。

队列历史和已加载持有者是两个时刻的视图。summary 已标 completed/interrupted，但当前订阅仍持有同一 active turn 时，adoptQueuedTurn 继续等待该精确轮次的最终通知，不能转入只读恢复并误报 queue/observe 断连。只凭“有订阅”或其他活动轮次不适用；没有本地同轮次持有事实时仍走原恢复路径。CTRL-03.5 用两个确定性 JSONL 反例覆盖早到终态，再用真实原生重复运行验证；不因此重发输入、强制 queue/start 或 interrupt。

模型、Skill、MCP 和额度来自原服务。Skill 以 name 和具体文件 path 组成选择身份，不能把不同 scope 的同名项合并；公开 item 映射过滤私有推理、审核器和 hook 内容，命令敏感值检查覆盖完整原串，再做长度裁剪。

## 直接验证

shared-app-server-integration、native-settings-integration、taskboard-native-integration 使用安装的原生二进制、临时 Home 和本机假模型。interaction-fanout、native-public-item 和 native-shared-catalog 覆盖原始请求范围、晚订阅、多消费者退休、异常/秘密字段及目录分页。NATIVE 系列列明具体行为范围；这些测试不证明所有供应商状态或实际手机界面均已验证。

SSH连接配置中的目标参数必须仍是目的主机；argv隔离shell不等于消除SSH选项解析，目标不得以减号开头。NATIVE-03.6验证注册用户名与hostId派生主机两种路径和正常目标。

原生 turn/completed 必须携带明确的 completed/failed/interrupted。缺失、非字符串或未知状态只显示“结束状态尚未确认”，不撤回待答交互、不清除接收身份、不合成成功或失败；后续有效终态继续处理。NATIVE-05.6 用真实 JSONL 子进程验证，长时间无有效终态仍依赖现有状态观察，不重发或中断任务。

NATIVE-05.7：原生轻读返回的当前状态优先于旧接收缓存；等待中收到新 start 的精确轮次优先于旧读结果。只在同一仍加载的所有者已 idle/systemError、接受的 thread/turn 未变化且 summary 含 items 和明确终态时，沿原完成通知处理器结算本地等待和交互。metadata 的 notLoaded 项目仅供状态观察，不能据此提前结算丢掉最终正文。notLoaded 核心、其他轮次、缺 items、仍 active 均不合成终态；没有重发或停止调用。

NATIVE-03.7：关闭退休整个 Gateway 分派器；晚到的只读查询不能重新创建远端适配器，远端文件传输也不能重新解析已退休连接。读和写共用连接获取边界的关闭检查。

native-bridge-instructions 使用真实安装的原生核心和隔离假模型，检查模型请求而非仅检查 RPC 参数：覆盖新建、同客户端空线程、另一客户端空线程及另一客户端已有历史四种路径，并再次续聊验证规则更新与旧原生规则保留。2026-11-03 的探探实测曾两次生成错误文件动作；旧 JSONL 夹具把 resume 参数当成已经生效，不能作为此契约的验收。实机记录见 audits/2026-11-03-tantan-regression。

NATIVE-02.7历史缺陷已修复：原生queue/add/start没有独立application context字段；新入队项在首次持久提交前携带渠道规则前缀，Gateway展示时按明确标记隐藏前缀。queued-bridge-context逐渠道检查真实模型请求、单输入和权限不变；peer-real-native检查Connector断连后的同一回执。旧已接收项不改写或重发，原生历史仍可能显示该前缀。探探审计中的pending-queue-context保留修复前失败证据，不能继续列作当前未修复。

显式UI设置在已加载线程上必须同时由 turn/start 应用 sandboxPolicy、approvalPolicy、approvalsReviewer、cwd 和 runtimeWorkspaceRoots；仅 thread/resume 携带这些设置可能只是重新订阅，不能证明已生效。workspace-write 的显式可写根来自完整选定runtime roots；原生返回会把隐式可写cwd从额外writableRoots中去重，核对时须结合cwd与runtimeWorkspaceRoots。普通续接和容量恢复省略这些覆盖，不因有审批回调而写入。真实Mac 0.166/Linux 0.163矩阵均验证了变更及下一轮继承。
