> 历史检查点：仅初版适配器阶段，不描述当前源码。当前结果见 README.md；原散列与 55 项证据保留，不补写成新代码通过。

# Herdr 两套适配：增量四层检查

日期：2026-11-07。源码基线 37b2a2c，产品目录版本 0.5.0。**本轮完成底层适配、交接模块和架构设计，未完成 Gateway 生产业务接入，未 push、发布或切换线上。** 不把本轮 55 个测试加入历史全库 427-case 的完成数。

## 结果

- Herdr TUI 与 Herdr App 两个 adapter；core 只是 App 执行依赖。
- 统一资源/证据类型，显式配置及目标身份，JSONL 连接/异常处理，屏幕读取与输入。
- 输入交接持久化与重复来源去重；终端输入回执不会生成原生 turnId，不把 idle 当任务成功。
- npm run typecheck 通过；两份增量测试共 **55 通过、0 失败、0 跳过**。完整测试名称和源码摘要见 [verification.json](verification.json)。
- 12 的 TUI 真实 Codex CLI 无工具输入与回复、断开后读取及同来源回执恢复通过；Mac App 真实终端 fixture 输入/状态/blocked 拒写通过。不是完整钉钉往返或全 agent 验收。

一次受限沙箱执行中，16 个 Unix socket 监听场景在 listen 处报 EPERM，39 项通过；失败没有进入对应协议断言。随后通过工具的授权执行相同测试，55 项通过。没有改成 skip，也没有修改测试断言绕过该限制。

## 第一层：整体架构

对现有 Codex facade → Connector RPC → 设备执行 → 输入回执 → 观察/卡片的依赖进行检查。发现需要拆开的不是 socket 连接本身，而是当前业务合同里的 native thread/turn、结构化审批/消息历史、结果终态等假设。详细的模块和函数迁移见 [设计第 8 节](../../architecture/herdr-adaptation-design.md#8-生产接入的代码级改造顺序)。

确定保留：Connector 唯一入口、来源与共享权利、原生设置唯一事实源、未知输入不重放、阶段/实时展示、原审批通知与答案链、IDE 文件权限。确定不采用：Herdr 假装 CodexBackend、用 core.turn 伪造轮次、把 blocked 转为自动 yes、第二套 Gateway 聊天业务、自建队列弥补 native queue。

上游研究覆盖固定 TUI 0.9.5、App 0.1.13 与其 core 0.1.18 的列明接口/函数；并非逐行审核三个上游仓库全部代码。Herdr 的多 agent 支持采用检测规则、专用 hook/plugin 与启动/按键模板组合，不等于每个 agent 都有统一结构化 SDK。证据文件和 SHA 见[接口调研](../../architecture/agent-runtime-interface-research-2026-11-06.md)。

## 第二层：模块与故障场景

| 功能要求 | 本轮证据 | 尚未覆盖 |
| --- | --- | --- |
| 稳定目录，保留空项目，不能同名串目标 | TUI terminal→pane 双核验；App space/terminal 关联；空组、替换、远端 identity 回归 | 生产 /sessions 分页、授权过滤及 App 远端完整性 |
| 输入只确认实际交接层次 | started true/false/null；失去回执、不兼容响应、重复来源 | 原生 CLI 内部接受/执行的所有时序 |
| 等待期间撤权/换绑 | readiness 后及 socket connect 后最终同步 guard；拒绝 async guard | 真实多人跨群、Web/IM 授权变更组合 |
| 无确认不重发 | 意图落盘失败零调用；确认落盘失败 unknown；重建返回旧回执 | 接到现有 PeerReceipts 后的双进程/升级迁移 |
| 崩溃恢复 | 子进程在 socket 收到输入后真实 SIGKILL，重载 unknown，无第二次写入 | 真正 Gateway/Connector 进程恢复卡片和投递 |
| 长任务与连接解耦 | 交接 lease 只覆盖 send；TUI 实际断开并继续读取；close 不杀进程 | 线上 RestartWork 新 scope 尚未接入 |
| 安全读取与中断 | App lines=0，不滚屏；未知身份可读不可写；中断仍 working 不报已停止 | App 实机 interrupt，TUI 按键中断契约 |
| 配置和连接固定 | 严格 schema；未知 kind/version/fallback 拒绝；配置变更身份变化 | 生产 CLI 配置迁移及旧版 mixed-version 协商 |

## 第三层：函数和代码

本轮新增 src/agents 下全部文件、两份测试和测试子进程文件已按实际控制流阅读。函数位置、文件 SHA 与完整阅读范围见 [code-review.json](code-review.json)。生成的位置索引只负责定位，人工判断范围由本段及下列分支记录限定，不把 AST 扫描当审查。

实际修正/补强：

1. TUI 普通公共请求每次连接只处理一次。真实 EPIPE 推翻了最初的长连接假设，现每请求建立连接，不重发失败请求。
2. TUI agent.get/prompt 接受 pane/name，不能把 terminal_id 当入参。现每次快照解析当前 pane，并核对返回 terminal_id；画面返回的 pane 也要一致。
3. TUI read 的正确 source 是 visible；agent_status 包含 done。以真实类型/调用校正，防止替身自洽而实际接口失败。
4. core holder/program_started_ms 属于 PRIVATE，不会出现在 Public。现只用公开 pid/foreground/created_ms 形成 observed 身份，明确不声称原子 compare-and-write。
5. 来源守卫移到 socket 建连 await 之后的真实 write 前。guard 关闭连接也不再排入写请求；Promise guard 被拒绝。
6. JSONL 按字节缓冲分片 UTF-8；非法 UTF-8、超限、错误 ID、通知异常、超时、close 都有边界。销毁连接的尾部缓冲不会沿用到新连接。
7. 远端错误正文不挂 Error.cause，避免常规日志把输入或 provider 数据带出。
8. 交接确认与任务成功分离；journal 保留 confirmed 回执，即使发送期间来源失效；来源失效也不能读取旧缓存形成旁路。

写前观察有不可消除的上游限制：TUI pane 位置在核验和原生执行间仍可能改变；无原生 session 身份的同类程序替换、PID 复用也可能不能识别。公共接口没有通用 CAS 字段，不能用多读一次宣称原子保证。

## 第四层：静态、配置、文档和构建

- 新配置是内部 adapter schema v1，生产 peer/index.ts 暂未接受；没有给用户发布一份实际上不可用的 Connector 配置。
- 交接 journal v1 不含 prompt 正文，不保存待执行重试任务；由既有单实例 stateDir 锁约束。版本/坏 JSON 解析失败保留原文件。
- typecheck 使用 --noEmit，隔离 bundle 仅生成在临时目录；未覆盖当前线上可能读取的 dist。
- 架构入口、功能合同、模块文档、命令设计、环境记录和剩余清单同步标明完成层次。原始调研记录保留历史时间点，追加实现状态入口。
- 原有 Codex 运行代码、生产配置、npm 版本、制品和服务进程未修改；本次未跑全库回归，也不声称全库重新逐行审查。

## 实机清理与剩余工作

仅关闭本轮创建的 Linux workspace 和 Mac App space，关闭前核对原 ID、名称、目录、终端及 Linux 空闲状态；两边清理后对应测试目录组为空。Herdr 测试服务/App 保留，生产会话和两套 Gateway/Connector 未动。

尚需完成的产品工作：runtime 注册/RPC；绑定与共享及持久迁移；全部命令子操作与 Web/Taskboard 的共同判断；观察与卡片；新建/命名/生命周期；实际文件主机和 IDE；最终跨设备/钉钉往返。清单不能用本报告的 55 个测试替代。后续每一步沿 [设计](../../architecture/herdr-adaptation-design.md)新增反例、正常对照及对应验收记录。
