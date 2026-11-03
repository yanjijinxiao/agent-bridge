# 历史问题对照：代码、断言与真实验证

基线：`fe2df3d`。本表依据本 session 和用户提供的《cs架构设计》导出；附件原始行号用 L 表示。历史结论不是本轮通过证据。`case 存在`也不等于所有交错已覆盖；当前 107 个 partial 不自动升级。

附件正文已按保留原行号的脱敏投影读完，排除了重复渠道包装和大段历史工具输出；L11304–11485 另回读补齐输出截断。相关失败的实现和断言在当前源码重新阅读。没有声称逐行重读了导出中的全部历史 shell 输出。

| 历史问题/要求 | 当前直接 case 与实际检查点 | 现有代码仍可能出问题的边界 |
| --- | --- | --- |
| 本轮真实 Gateway 崩溃后，任务完成而文件提示“接收会话未知” | 新增 `dingtalk-file-restart`：13 项覆盖私聊/群聊路由重建、真实 Bridge/状态持久化、原有效凭据恢复文本/文件、模型不含凭据及错误作用域；未知目标零上传。两个原始恢复正例修复前失败 | 私有 webhook 仅经原 contextToken/0600 状态保存，校验作用域和期限；公开路由无凭据。过期后主动发送仍受平台权限限制，真实群聊未验收 |
| 本轮实测文件动作格式错误：续接线程未收到 Bridge 规则 | 新增 `native-bridge-instructions`，直接检查真实原生核心发给模型的请求；四种创建/续接与再次更新路径。修复为 turn/start application context，保留原线程规则 | 模型仍可能不遵循规则；规则注入与渠道实际文件回执分开验收。旧 resume 参数夹具的通过结果不能证明规则已进入模型 |
| 任务完成却不回 IM（L7486） | `peer-bridge`：精确设备会话续聊、结果返回、设备模型；`peer-native-compat`：设备未注册时仍保留 follow | Gateway/设备同时断线、供应商写后无确认；不能以 native completed 推定已投递 |
| 原始/Peer 消息 ID 不一致，恢复永久未知（L12126） | `peer-input-recovery`：持久 Peer ID 重启恢复，AccountManager 落盘 accepted，runs=1；跨账号/聊天/actor 拒绝 | 原生历史不完整、相同 source 对应多 turn 必须保留未知，不可重发 |
| 长历史扫描每轮重置（本轮 IN-A） | `native-input-recovery`、完整四层审阅 IN-A 反例：短刷新预算与长扫描分开 | 原生历史始终不可读或扫描超出独立总预算仍未知；不是保证任何旧记录恢复 |
| 接收回执前崩溃、重启吞输入（L12661） | `peer-input-recovery`、`peer-execution` accepted/ambiguous 不重放；native crash 恢复证据另见四层审阅 | 本轮在 START 后 DONE 前真实 SIGKILL 探探 Gateway：原生用户输入一次、标记各一次、原卡和文件完成；其他 accept/fsync 精确窗口另验 |
| 容器 PID 1 复用，旧锁误拦重启（L12661） | 当前测试容器使用稳定外层 PID namespace；锁检查见 `process-lock` | 部署参数也属于契约；纯进程测试不能保证错误 Docker 启动参数 |
| 重启误停止 Codex 任务（本 session） | `peer-execution`：durable Gateway acceptance 后解除观察；`shared-app-server-integration` 同一 core 续跑 | 私有 stdio 生命周期仍有差异；仅确认 daemon 独立时可按独立任务处理 |
| 门禁把等待响应当未交接（本 session） | `restart-handoff-boundaries`、`restart-ownership` 区分未完成提交与独立观察 | 审批答案/投递仍在写入时应保护；不能去掉所有交接边界 |
| 审批两分钟失效（L10846） | `peer-execution` delayed interactions：虚拟时钟推进180秒，approval/question 均仍待答并确认原对象 | 本轮真实等待超过两分钟再断开 Connector，恢复审批成功；其他平台策略另验 |
| 审批返回后无法关联确认（L10846） | 同上，`peer-interactions`：原对象引用、host、request ID；`backend-transport-contract` 三路径 | 多来源同时审批与原生重放需按 request+host+thread+turn 核对 |
| 审批断连变成默认拒绝（L13671） | `peer-write-boundary`：callback error、缺 handler、断连均 undefined；明确 decline 正常对照 | 显式用户拒绝必须继续传达；unknown 不代表拒绝成功 |
| 断线恢复同时出现两个可用审批（L14858） | `peer-write-boundary` disconnected run 先 withdrawn；`peer-interactions` 原生 JSONL 同 core 一次回答 | 本轮已实测 A9 过时拒绝、A10 成功、文件只写一次；多人竞争仍未实测 |
| 审批没有@人，批准后没有新卡（本 session） | `approval-card-roundtrip`：只@轮次参与者、1次run、2张不同卡、旧卡终态；`approval-host-progress` 完整主机身份 | 私聊不等于真实多人群@；手机呈现仍未代验 |
| 只读+人工审批覆盖原工作区权限（本 session、L9974） | `native-settings-integration`、`native-explicit-settings`，`peer-complete-contract` nativeSettings 原样传输 | 新建空会话采用原生默认；需要区分原生默认只读与 Gateway 覆写。不能为了测试把所有会话提权 |
| 同一 App 却出现写入权占用（本 session） | `shared-app-server-integration`、`native-shared-catalog`；只读观察不创建另一执行 core | 桌面/CLI 实际连接地址不同或另一客户端持有写权仍可能发生；须比较 native PID/endpoint |
| workspace routing/systemError 恢复（本 session） | `system-error-lifecycle`：先持久恢复责任、archive未知补偿、撤权仍恢复；`peer-complete-contract` device journal | 活动 goal/新任务阻止重置；原生能力不足/未知 archive 不可冒称已修复 |
| “执行状态待确认”长期挂卡（最新截图） | `thread-system-error`、`session-follow`：精确可信终态才结束，补发原卡，迟到 idle 不覆盖 active | 缺少可信原生终态时必须显示未知；进一步查具体旧 turn 不能靠计时猜成功 |
| 无正文 completed 被当失败（本轮 FINAL-EMPTY-A） | 完整四层审阅中的 monitor live/recovered 反例 | 完成回执与正文分开；空完成不伪造模型回答 |
| 进度卡中断、重复占位/格式变乱（本 session） | `dingtalk-progress-layout`、`dingtalk-code-blocks`、`session-follow`：统一 renderer、同卡、静默恢复 | 实际钉钉客户端版本、消息折叠、设备宽度需要单独观察 |
| 复制框丢失（L11304、本 session） | `dingtalk-code-blocks` 检查确切命令和独立块；`dingtalk-selection` 在写前选择路线 | 缺 cardTemplateId 时没有原生卡控件；需配置核验，不能另写一套渲染 |
| 写卡失败转文字导致重复（本轮 DT-SELECT-A） | `dingtalk` uncertain creation / no webhook replacement；四层审阅写前能力选择 | 供应商确认丢失只能核对原逻辑实例，不能盲目重发 |
| 进行中/最终 Web IDE 链接消失（本 session） | `progress-ide-footer`：running/waiting/recovering/unknown、发送时重新投影、终态唯一 | Peer `/ide` 当前是 owner 授权的文本工作区；完整 code-server/Taskboard 尚未接通，不能当成同功能已交付 |
| /sessions 空项目不显示、R编号漂移（本 session、L10330） | `peer-bridge`：7项目分页保留空项目，第二页R1精确绑定；`catalog-presentation-regressions` | 实际 Desktop 项目别名和多root必须逐设备核实 |
| 新线程创建后项目归属不匹配（L8648） | `peer-project-identity`：legacy/native alias、不同home隔离；底层本地/SSH目录不变 | 无明确映射时不能按同名/同目录猜项目身份 |
| /connect 自动泄露全部 sessions（L9643） | `peer-bridge`：配对后 catalogReads=0，用户主动 /sessions 才查询 | 本机确认授权是profile范围；固定thread模式另有限制 |
| 降权/换绑后迟到原生写入（L13671、本轮 CONNECT-A） | `peer-write-boundary` 11种JSONL写、resume后撤权；`peer-bridge` unchanged/binding/ABA/role | 每个新增写端口都要保留最终 guard，不能仅校验接收请求时 |
| 回调/状态误用 Gateway 本机主机或模型（L9974、STATUS-A/B） | `peer-native-compat` 无本机fallback；`peer-bridge` status/model/balance，metadata DTO | 设备不可达时只能未知，不能显示本机默认冒充远端 |
| 队列历史早到终态，观察误报断连（本轮） | 新增 `native-queue-terminal-view` 两个修复前失败反例；真实 RPC 捕获同轮次 active 与 terminal summary 不一致，修复后 40 次真实核心重复通过 | 仅本订阅持有的同一 active turn 适用；其他客户端消费与落盘交错另验 |
| 普通消息错误queue、重启重发（本 session） | `backend-transport-contract` 队列原ID/顺序/删除；`peer-real-native` 真实core重连2次模型调用 | 两客户端同时append、队列被消费与回执落盘精确交错仍需扩大实测 |
| queue返回后审批回调被回收（L15458、17020） | `peer-complete-contract` late callback、取消true释放/false保留、原请求对象 | Connector断连后应靠独立订阅恢复，不能合成决定 |
| capacity/queue来源混用（L17020、17144） | `peer-complete-contract` snapshot 原source、跨actor恢复、thread coordinator隔离 | 来源缺失旧记录不能借任意已授权actor恢复 |
| 附件回传错误主机、授权撤回后仍发布（L7815、本轮 PEER-UPLOAD-A） | `peer-files` chunk/checksum、跨chat、换绑、异步lease复验、清理；`dingtalk-files` 真发送适配 | DWS无resourceID时不能宣称钉钉副本哈希验证；源文件哈希不足 |
| 共享角色重复、旧只读迁移变宽（L12977） | `peer-sharing` 旧委托需重批，owner/配对保留，复用 /role；不能转授 | 当前用户实测不能替代第二真实用户/群聊权限验收 |
| 共享浏览器授权重启丢失（L13812） | `shared-portal-persistence`、`peer-sharing` 撤销cookie/复制URL/CSRF/持久授权 | 29 当前resources publicOrigin仍是回环地址，只适合隧道测试，不能当手机可达入口 |
| 两个后端抢同一探探消息（L7249） | 历史外部重复接入已停；当前仅确认本测试容器与Stream连接 | 另一个未掌握的后台再次接入仍会竞争，单元case不能排除部署外实例 |
| 拆分重命名/归档命令误删已有能力（L16411） | `peer-main-orthogonality` 通用命令未混入，方法参数/对象身份不变；原生管理端口仍有契约 | 已按用户要求拆出的产品命令不算当前缺陷；不能把历史曾有功能自动加回 |

## 本轮验证记录入口

最终根回归 3029 项：3028 通过、1 Windows 专用跳过，真实临时原生核心和 Chrome 已显式启用。原 Taskboard 563 项证据来自此前完整四层回归，测试文件未变，本轮不称作重跑。新增三项功能 case 共 19 个直接测试。实际失败、修复、构建、审批与文件回执见 [真实验证](real-validation.md)。

107 个 partial 保留各自限制；Peer 完整 IDE/Taskboard、手机外部入口等实际缺口仍在当前未完成工作中。

- 新确认未修复 NATIVE-02.7：首条原生 queue 输入缺少渠道规则，已有真实模型请求失败反例；不能以普通续聊或已有历史的队列测试通过代替。详见 README 的单列未修项。
