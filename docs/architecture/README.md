# 架构、功能与模块说明入口

这些文档同时记录目标行为、当前实现和未验证项。存在文档、读过文件、测试通过是三种不同的事实，不能互相替代。

2026-11-11 App 旧会话在 `/sessions` 项目中遗漏的展示兼容及 Connector 过滤修复见[四层检查记录](../audits/2026-11-11-legacy-catalog-grouping.md)。展示分组不参与原生归属、绑定及授权判断，验证与上线状态分别记录。

这两处修复的最终 push、两套 Gateway/受维护 Connector 上线及 npm 0.6.3 候选准备结果见[发布核验](../audits/2026-11-11-v063-preparation.md)。npm 正式发布与线上构建分别记载。

npm 0.6.3 随后已正式发布并完成公开下载、干净安装及 GitHub Release 对照；见[正式发行记录](../audits/2026-11-11-v063-release.md)。

2026-11-12 大响应 Socket 代理拥塞及未提交重试误报失败的检查见[四层记录](../audits/2026-11-12-socket-relay-pressure.md)；新预算是传输边界，不是原生执行终态。

2026-11-11 Codex 原生核心冷恢复权限缺失的修复与测试范围见[四层检查记录](../audits/2026-11-11-native-cold-permissions.md)；原生进程重启与客户端暖重连分开验证，上线状态另记。

2026-11-11 Herdr 被动跟随误推与终端标点修复见[四层检查及上线记录](../audits/2026-11-11-herdr-idle-follow/README.md)。修复构建 0.6.3 的代码、验证和部署分别留证，npm 正式发行状态不由此推断。

最新已完成发行见 [0.6.2 发布记录](../audits/2026-11-10-v062-release.md)，修复 DingTalk 引用解析并同步教程；上一版见 [0.6.1 发布记录](../audits/2026-11-09-v061-release.md)，修复 Codex 进行中阶段正文补读和截断；基础 Herdr 接入与双环境发行见 [0.6.0 发布记录](../audits/2026-11-09-v060-release/README.md)。npm、GitHub 与各运行组件的实际构建分别核对。旧调研和审计按日期保留，不将其中“尚未发布”或旧版本号当作当前状态。发布后的文档修订见 [文档核对](../audits/2026-11-09-v060-documentation.md)。

[整个 session 的需求与决定索引](session-requirements.md)按历史要求定位当前功能、模块和 case，并标明被后续要求取代或取消的方案。2026-11-09 已重新核对三段历史中的 894 条用户记录；补齐功能总文档缺少的条目、Herdr 合同入口及相反的旧待办描述，范围见[本次复核](../audits/2026-11-09-session-documentation/README.md)。这是文档审计，不是新一轮全部代码验收。

## 接口调研与设计提案

[Herdr 两套适配的模块、函数与代码设计](herdr-adaptation-design.md)：列出真实调用链的 Codex 假设、Herdr 多 agent 源码依据、身份/交接/观察边界和实施验收清单。开发状态与上线状态分开记录。

[Herdr 底层适配四层检查](../audits/2026-11-07-herdr-adapters/README.md)：源码增量、函数清单、隔离回归及 12/Mac 实机边界。两套适配、生产 Connector 入口、生命周期、命令/卡片、Web、文件/共享/IDE 已落入源码；当前检查表区分实机通过和发布/设备边界。历史 427-case 汇总不包含这次新增设计范围。

[Herdr TUI / App 与通用运行接口调研](agent-runtime-interface-research-2026-11-06.md)：对照当前实现、Codex App Server、Herdr 的两种执行后台及 App 窗口接口；以 Claude Code、OpenCode 等检验未来适配边界。记录源码版本、接口差异、迁移建议和 32 个待验证场景，尚不是已实现或已验收功能。

[命令与业务能力契约补充设计](agent-command-compatibility-2026-11-07.md)：逐项核对 36 个内置命令及别名，拆分子操作、Gateway 业务与原生能力，补充 Taskboard、QA、扩展、帮助/按钮/执行的一致判定及 24 个待实现 case。文中的 3 项帮助测试与待办是改前基线；当前命令/别名、调用面和具体用例结果见 Herdr 四层检查。两篇提案需一起阅读。

同文第 1.1～1.3 节已追加 Herdr 上游接口证据：核对 TUI 102 个请求、core 32 个方法和 App 71 个内置界面命令，确认 11 个 Bridge 命令的核心原生操作无等价结构化接口，并区分已有目录/输入/中断/观察能力及终端历史的限制。属于源码核实，尚非集成验收。

## 当前未完成工作

[当前剩余清单](remaining-work.md)分开记录未实现功能、缺测组合与真实设备验收。2026-11-08 按需求 JSON 汇总：96 项要求、459 个 case，364 项已有窄边界通过记录、95 项部分覆盖，全部有测试映射。数字不是本次全库重新验收结果；历史证据仍有版本和环境限制。最近命令、帮助及 IDE 修复的五项合同与十项函数记录见[文档同步记录](../audits/2026-11-08-documentation-reconciliation.md)。

## 阅读顺序

新增统一版本制度见[版本、兼容和日志架构](version-contracts.md)，本轮增量与验证边界见[四层检查记录](../audits/2026-11-06-version-contracts.md)。Gateway、Connector、接口契约、日志结构分别核对；旧清单计数是历史检查点，不代表本轮全库重新验收。

1. [功能契约](gateway-contracts.md)：从公开会话提炼的行为要求，保留历史来源与被后续要求取代的决定。
2. [实现职责图](gateway-implementation-map.md)：18 个模块的真实入口、状态写入者、原生与 Gateway 的边界。
3. [需求与 case 清单](gateway-requirements.json)：每个功能的反例、正常对照、精确测试名、源码散列及验证边界。
4. [场景覆盖摘要](gateway-case-coverage.md)：方便阅读的汇总；数字不表示整个模块已验收。
5. [函数意图记录](function-contracts.jsonl)：已专门分析的函数职责、范围、限制。该清单只覆盖已列出的函数，不代表仓库所有函数都已逐个验证。
6. [本轮逐行审查记录](../audits/2026-11-03-full-four-layer/README.md)：文件版本、实际阅读范围、失败和修复证据、待办。

## 模块说明

| 模块 | 说明 |
| --- | --- |
| Connector 唯一执行入口 | [Peer 的接口适配、授权和验证边界](modules/peer-transport.md) |
| 原生协议与连接 | [同一核心、权限继承、读写连接和生命周期](modules/native-protocol.md) |
| 多 agent 运行接口 | [两套 Herdr 适配、输入交接、命令帮助及能力边界](modules/agent-runtime.md) |
| 消息接收与交接 | [来源、提交、接收和未知回执](modules/inbound-forwarding.md) |
| 持久状态与账号 | [版本、迁移、内存/磁盘一致性和特殊标识](modules/persistent-state.md) |
| 绑定及准入 | [精确会话边、个人/群身份和撤权](modules/bindings-access.md) |
| 目录及历史 | [原生 ID、旧别名、全部根和有界日志观察](modules/catalog-history.md) |
| 输入和控制 | [普通输入、steer、原生 queue 和写前核验](modules/input-controls.md)，[目标控制](modules/goal-controls.md) |
| 审批及提问 | [原请求、多消费者、明确答案和秘密字段](modules/native-interactions.md) |
| 系统及容量恢复 | [只读核对、恢复交接和持久补偿](modules/recovery-coordinators.md) |
| 进展、结果及渠道 | [按轮/页回执、未知不补发、复制和网络边界](modules/delivery-channels.md) |
| Web IDE | [完整 scope、个人确认或显式持链接访问、90 天及独立进程](modules/ide-access.md) |
| 管理 UI | [原目标、迟到请求、原生表单和可选模块](modules/management-ui.md) |
| Taskboard | [原生执行和交互](modules/taskboard-native-execution.md)、[表单与附件交接](modules/taskboard-data-handoffs.md)、[工作流编辑](modules/taskboard-workflows.md) |
| 知识与 QA | [只读工具、实际文件边界和独立 MCP 所有权](modules/knowledge-qa.md) |
| 构建与重启 | [同一交接门禁、制品和实际运行版本核验](modules/release-lifecycle.md) |
| 四层检查与证据 | [历史、意图、逐行范围、反例和验收限制](modules/audit-method.md) |
| 文档与教程维护 | [需求变更、教程结构、同步和正交验收](modules/documentation-maintenance.md) |

上述说明按职责组织，其中绑定/准入、进展/渠道合并解释跨模块边界。Connector 与多 agent 运行接口已是当前架构的一部分，不能沿用早期“实验 Connector”身份遗漏它们。文档维护是开发流程职责，不新增运行模块。机器清单中的状态和设备验收限制仍独立保留。

## 注释约定

注释说明“为什么”和必须保持的边界：事实由谁持有、异步等待后为什么重新核验来源、写前落盘的时机、未知回执为什么不能重放、补偿由谁负责。参数和简单赋值不逐行翻译；代码本身难以表达的职责应在模块说明中写清楚。

修复时同时检查调用者、被调用者和持久记录，补一项能在旧版失败的反例，并保留正常对照。只改注释、测试名或计数不能作为功能修复。详细注释也不能代替实际 case。

## 四层复核的记录方式

- 架构：核对职责和事实源，有无第二条执行链、生命周期耦合或不受约束的写入入口。
- 模块：沿真实入口走完准备、提交、确认、失败、重启和来源变化；按功能意图判断结果。
- 文件与函数：记录源码版本及行范围；新修改必须复核实际差异和受影响调用链，不能直接沿用旧版本的“已读”。未变化的旧阅读范围若继承，须注明来源版本和逐行相同的范围。
- 静态与配置：核对启动、端口、默认值、构建制品、文档链接、迁移和回滚说明，不能把本机特例写成统一默认。

未覆盖的设备、真实供应商回执、纯 CLI 环境及未解决失败持续列在审查记录中，不以全套 Gateway 测试通过抹去。

## 近期功能索引

以下按当前用户可见行为定位功能契约、模块说明和 case；表示文档已覆盖，不把部分测试或手机未验改成验收完成。

| 功能点 | 功能与 case | 模块说明 |
| --- | --- | --- |
| 未注册斜杠提示后原文转发，注册控制及路径不误判 | IN-01.slash-forwarding | [输入合同](slash-routing-and-runtime-help.md)、[消息交接](modules/inbound-forwarding.md) |
| Herdr 全量、分项和单命令帮助与实际能力一致 | CTRL-05.runtime-help | [运行接口](modules/agent-runtime.md) |
| IDE 内置浏览器兼容、明确失败与手动重试，不自动循环 | IDE-14.webview-timeout | [IDE 访问](modules/ide-access.md) |
| 相同承接阶段去重，保留所有不同回执和旧最终结果 | STATE-01.stage-dedup | [持久状态](modules/persistent-state.md) |
| 短暂探测失败保留中继，持续失败恢复、成功清旧错误 | IDE-03.health-retry | [IDE 访问](modules/ide-access.md) |
| 审批消息 @ 原参与者；原生确认批准后新 AI 卡继续同一任务 | INT-01.8、INT-04.4 | [原生审批与提问](modules/native-interactions.md) |
| /sessions 按项目+session显示，保留空项目、置顶和稳定分页编号 | CAT-02.4 | [目录与历史](modules/catalog-history.md) |
| 进行中及心跳卡保留 IDE 链接；远端重连不删除固定入口 | IDE-01、IDE-09.4 | [IDE访问](modules/ide-access.md)、[结果与渠道](modules/delivery-channels.md) |
| IDE前置核验超时明确未批准；不改任务或绑定 | IDE-05.4 | [IDE访问](modules/ide-access.md) |
| 单一原生App Server、续聊权限继承、Taskboard共用原生执行与目录 | NATIVE-02.5、TB-04.2/.4 | [原生协议](modules/native-protocol.md)、[Taskboard执行](modules/taskboard-native-execution.md) |
| 原生接收与回执落盘间真实崩溃，精确恢复接收与离线完成的结果，不重发 | IN-02.2 | [接收交接](modules/inbound-forwarding.md)、[恢复记录](../audits/2026-11-01-four-layer-recheck/2026-11-02-native-crash-recovery.md) |
| 重启仅保护实际消息交接；已接收任务继续，既有远端重连不锁重启 | REL-01.9、REL-02.5 | [发布与重启](modules/release-lifecycle.md) |
| systemError恢复、容量只读对账不阻塞重启或重放原输入 | REC-01.4、REC-02.4 | [恢复协调](modules/recovery-coordinators.md) |
| 阶段成果保留、实时窗口、超长续卡、原图标及缩进；任务结束与结果待投递独立；钉钉原生两区与独立复制控件 | DEL-08.8–DEL-08.11、DEL-09.5 | [阶段架构](phase-progress.md)、[渠道模块](modules/delivery-channels.md) |
| /stop独立复制框、连续卡片更新、分段后最终@与IDE归属 | DEL-10.1、DEL-09.3、DEL-08.4 | [结果与渠道](modules/delivery-channels.md) |
| Web区分执行完成与答复待投递；审批漏重放与可信问题快照 | DEL-01.3、INT-02.1/.2 | [管理UI](modules/management-ui.md)、[原生交互](modules/native-interactions.md) |
| 原28项补测、精确断言和剩余范围；33种流程节点的配置与执行边界 | AUDIT-01、TB-10.3 | [审查方法](modules/audit-method.md)、[节点对照](taskboard-node-contracts.md) |

功能总文档与需求JSON对应；精选函数合同只覆盖已登记的函数，不代表仓库所有函数均已逐个验收。

## 当前检查点

2026-11-08 文档同步：功能合同、实现职责图、模块说明、case 汇总及函数索引对齐最近三个代码提交；只更新文档，不重启服务。最新代码回归为 3760 项（3669 通过、91 条件跳过、0 失败），不是本次文档维护新跑的全套测试。真实远程 IDE 打开与运行版本记录见[同步记录](../audits/2026-11-08-documentation-reconciliation.md)。三份有界检查分别为[命令与帮助](../audits/2026-11-08-slash-help.json)、[浏览器兼容](../audits/2026-11-08-ide-link-compatibility.json)、[远程 IDE 稳定性](../audits/2026-11-08-remote-ide-stability.json)。

以下为历史增量检查点：

2026-11-05 阶段展示和终态回归：54 项定向检查通过，根回归 3336 项（3250 通过、86 条件跳过、0 失败）；b45af83 当时已推送并用于头头、探探。手机显示与附件实际可见性仍须按真实接收情况核对。

2026-11-04权限展示增量：/access默认本人和当前聊天，管理员跨聊天管理只在私聊显式进行；/connect明确现有三元授权范围。完整根回归3096通过、0失败、82环境跳过；其他未改功能保留既有有界证据。详细四层范围、函数比较、跳过项和上线回执见上述增量报告。

以下为此前全库检查点：

本轮基线 d2adf14 的四层审阅与隔离验证已完成；Gateway 3009通过/1 Windows跳过，Taskboard 563通过。960个文件范围及各层证据见[本轮结论](../audits/2026-11-03-full-four-layer/conclusions.md)。106个partial保留原限制；推送与实际生产版本单独核验。上轮四项修复及2881/1结果保留于[历史修复记录](../audits/2026-11-03-main-review/fixes.md)。

## 历史检查点与来源

2026-11-02普通输入真实崩溃恢复检查点新增19项检查；完整根回归2718通过、1项Windows专用跳过，精选函数合同151项。推送、准备制品与实际运行版本分别按发布manifest核验；此前业务版本afbd2d2及其2691/1检查属于上次发布。CTRL-03.3的联合场景另见下列记录。原生workflow未知交接、真实SSH/手机联调、33种工作流节点执行等仍在剩余清单中。

- [真实崩溃恢复](../audits/2026-11-01-four-layer-recheck/2026-11-02-native-crash-recovery.md)：先复现两个真实缺口，再验证6种SIGKILL与13项边界，IN-02.2仍保留未测范围。
- [队列终态与原卡投递联合检查](../audits/2026-11-01-four-layer-recheck/2026-11-02-queue-delivery-integration.md)：三终态×有无新轮次、两次管理器重建、原生仍运行冲突与正常执行。
- [文档与13项验证边界校准](../audits/2026-11-01-four-layer-recheck/2026-11-02-documentation-reconciliation.md)：当前索引、状态汇总、原生/Taskboard职责及每项已测/未测。
- [渠道媒体适配记录](../audits/2026-11-01-four-layer-recheck/2026-11-02-feishu-wecom-media.md)：飞书文件/MP4视频、企微出站图片/文件/视频及实际SDK与真实平台的区别。
- [原28项补测记录](../audits/2026-11-01-four-layer-recheck/2026-11-02-gap-regressions.md)：304case阶段的历史快照，不作为当前计数或部署版本。
- [33种节点配置/执行对照](taskboard-node-contracts.md)：配置可保存不等于节点可执行。

后续维护同时更新当前入口、需求JSON与人读场景；历史报告保留当时事实并注明历史身份。手机实机验收继续单列，不新增为发布门禁。

## Connector 合并检查点（2026-11-03）

新增PEER-01～PEER-04及9个明确场景，逐项映射实际测试；主分支原310case的验证边界保留。查看[完整接口表](modules/peer-interface-matrix.md)、[功能文档](../gateway-peers.md)、[本轮合并记录](../audits/2026-11-03-peer-contract-review/merge-completion.md)。本轮没有把已有完整Web IDE/Taskboard的产品入口声称为Connector支持。

Connector合并时的历史检查点为319个case（213个窄边界通过、106个partial）、160条精选函数合同；当前值见首页。Connector增量不会将主分支未验证的产品组合改成通过。

- [原生执行设置唯一权威：CTRL-06](../audits/2026-11-05-native-execution-settings.md)：模型/effort/Plan 原生设置、生效确认、旧覆盖值退休、IM/Web/Connector 一致性。

- [进行中卡片重复控件回归：独立区域与按字段更新](../audits/2026-11-06-stable-progress-controls.md)
