# 单一原生协议与核心所有权

Gateway 的业务端口是 src/codex/backend.ts。Gateway 通过 connectorOnlyBackend 把逻辑主机路由到 Connector；设备侧 CodexAppServerGateway 负责原生连接角色；AppServerCodexRunner 负责原生请求、通知与精确线程/轮次；daemon/remote-host/transport 只解决服务部署和连接。桌面和纯 CLI 的业务方法相同。自定义可执行文件名不决定是否创建私有核心。

## 事实源和生命周期

原生核心保存线程、队列、目标、执行权限和运行事实。Connector 的主连接、元数据读连接、大历史读连接指向同一核心；读端口超时可以退休自身，但不停止执行核心。显式 stdio 是宿主拥有的私有连接，退出宿主会结束它，不具有独立 daemon 的重启保证。嵌入 Taskboard 借用 AccountManager 的原适配器，close 不拥有核心；独立 Taskboard 创建一个选定适配器，不启动 exec 回退。

普通续聊省略 nativeSettings 并继承已有 sandbox、审批策略和 reviewer。只有拥有设置的 UI 明确提交 nativeSettings 才主动选择新设置；冷恢复按下述边界恢复最新原生权限事实。onApproval 回调存在不构成改权限的理由。thread/start/resume 的返回身份、turn/start 的接收、运行终态与投递状态分开；有界 RPC 超时不能结束一个已接收的长任务。

## 冷恢复权限

NATIVE-02.8 区分 Connector/Gateway 客户端重连与原生核心进程重启。0.167.0 的裸 thread/resume 冷加载会丢失网络和额外写目录；原先保持同一 native PID 的 NATIVE-02.2 不覆盖此缺陷。

六个恢复调用统一经过 resumeThread。先 thread/read 核对精确身份和加载状态；已加载线程只附着，不回放权限。notLoaded 时，通过同一 App Server 的专用只读客户端以 fs/readFile 读取该线程的原生路径，按顺序选取最新 thread_settings_applied 或 turn_context。nativePermissionResume 不建缓存、不回滚到更早的宽授权、不读取同名本机文件。模型、effort、Plan、指令与项目归属不进入恢复投影。

具名权限使用原生 active_permission_profile.id，域名、deny 和后续配置变更继续由原服务解释。传统 workspace-write 恢复网络、额外可写目录及两个临时目录排除标志，并核对所有 runtime roots 都已具有相应写权限；只读与 full-access 保持已记录的模式。无法无损表示的匿名复杂权限、缺失状态/路径、半写或损坏记录明确失败，不猜测默认值或扩权。读取完成后重新校验来源/绑定或观察者；只发一个恢复请求，不补设置写入、占位任务或原始输入。

NATIVE-02.9：fs/readFile 当前没有分段参数，fs/getMetadata 也没有 size 字段，不能凭空添加范围或大小参数。保留 128 MiB 的权限恢复预算；同一控制连接不能承担这个批量传输。共享 daemon-proxy/remote-daemon 通过临时的 permissionReadOnly 客户端读取，只允许 initialize、initialized、fs/readFile；不发送任何原生决定。它连接同一个独立核心，不启动新执行器，读失败只释放自身。父 Runner.close 负责等待并关闭临时客户端。本机 daemon-proxy 在发送前检查原生返回路径的本机文件大小，已知超限直接失败；远端不检查同名本机路径。metadata 只决定是否拒绝已知超限，不是权限证据，也不代替原生内容验证。私有 stdio 不因此启动第二个核心，仍走原读取路径，其超大响应隔离不在本次证明范围。

内容只在设备侧解析，不进入日志或 Gateway。原生权限记录不可用时须在 Codex 核对，不能自动恢复已经丢失的更早授权。队列在提交前失败则释放本次来源；实际开始 queue/add 后的未知回执继续保留，不自动重发。真实 CLI、桌面内置核心和 Linux 隔离验证分别见[四层记录](../../audits/2026-11-11-native-cold-permissions.md)，不是重启用户线上核心的验收。

Bridge 的渠道规则与原生执行权限也分开。新线程通过 thread/start 的 developerInstructions 设置创建规则；续接已有线程时，用 turn/start.additionalContext 中稳定的 codex-im-gateway application 项传入本轮规则。不能假定 thread/resume.developerInstructions 会更新已加载线程，也不能因为已经订阅、改走 thread/read 就漏掉规则。每轮规则更新不替换原线程的 developer instructions 或权限，不混入用户输入/会话标题。Mac 0.166 与 Linux 0.163 均提供该原生实验字段；初始化须启用 experimentalApi。

## 调用边界

本机 daemon 连接先探测配置中同一个 codexHome 的原生控制 socket。已有服务可连接时直接完成原生握手，不要求 PATH 中另一个 CLI 先执行 daemon start；仅 socket 不存在或连接被拒绝时才启动同一服务。权限错误、无效路径及探测超时明确失败，不删除 socket/锁、不自动改走 stdio。连接准备失败与原生 RPC 拒绝用不同错误类型表示；Connector 只回传安全阶段、方法及数字错误码，原始 stderr/provider 报文不进入聊天。

NATIVE-01.6：本机和 SSH 共用的 APP_SERVER_SOCKET_RELAY 按分块队列消费 WebSocket 字节。未完成帧不反复 concat 全部前缀；跨块完整载荷只分配一次，分片完成后再整体解码 UTF-8。单帧及累计消息最大 256 MiB，握手头最大 64 KiB；从帧头拒绝超限，不截断为成功。该预算容纳 128 MiB 权限记录的 base64 信封，但不承诺处理任意大小的整段历史。stdout 背压暂停 socket，drain 后继续当前解析；close/EPIPE 仅关闭本连接，不控制原生执行器或重发 JSONL。隔离大帧复制量、边界及现场读检查见[检查记录](../../audits/2026-11-12-socket-relay-pressure.md)。

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

## 原生执行设置

`thread/settings/update` 修改会话后续轮次的模型、推理强度或 Plan 模式。RPC 的空成功响应只表示接收；Runner 先订阅同一 thread，再等待匹配的 `thread/settings/updated` 确认应用。Plan 切换从 `thread/resume` 的完整 collaborationMode 计算，不用本地标志猜测。首次创建空线程的 rollout 索引可能稍晚可用，仅对明确的 no-rollout 读/附着拒绝做有界重读；不重试设置写入，不创建占位轮次。

`thread/read` 用于当前模型/effort 查询，普通 `turn/start` 省略执行设置以继承原生值。设置期间正在执行的轮次自然完成；更新影响下一轮。未知设置回执保留为 unconfirmed，不降成可重试的 preflight。旧版本缺接口明确报错，不能用 Gateway 数据或新任务模拟成功。能力验证和部署版本见 [CTRL-06 检查记录](../../audits/2026-11-05-native-execution-settings.md)。

## 适配版本和原生握手诊断

本项目 nativeAdapter 契约在 runtime/versions.ts 登记。initialize.clientInfo.version 来自当前制品产品版本；原生返回的 userAgent 单独写入 native.connected，不能当作 Connector 构建号。request 日志只写方法、请求/连接 ID、hostId、耗时和安全错误类别，继承上层 Peer 请求上下文；不序列化原始参数、结果、审批内容或 provider 文本。

日志不改变发送、超时、接收和异常传播。重新建立原生连接使用新 nativeConnectionId；旧原生任务仍由其原生执行器持有。VER-01.8 验证并发上下文不混用，VER-01.12 验证日志输出失败不改变返回结果。
