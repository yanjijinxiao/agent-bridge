# 架构、功能与模块说明入口

这些文档同时记录目标行为、当前实现和未验证项。存在文档、读过文件、测试通过是三种不同的事实，不能互相替代。

## 当前未完成工作

[当前剩余清单](remaining-work.md)：本次另复现1个IM Taskboard重复创建问题（TB-09.5），尚未修复；当前305case中199窄边界通过、105部分覆盖、1失败。原28项已映射与新发现分开记录，未实现、缺测与实机未验不混算。

## 阅读顺序

1. [功能契约](gateway-contracts.md)：从公开会话提炼的行为要求，保留历史来源与被后续要求取代的决定。
2. [实现职责图](gateway-implementation-map.md)：17 个模块的真实入口、状态写入者、原生与 Gateway 的边界。
3. [需求与 case 清单](gateway-requirements.json)：每个功能的反例、正常对照、精确测试名、源码散列及验证边界。
4. [场景覆盖摘要](gateway-case-coverage.md)：方便阅读的汇总；数字不表示整个模块已验收。
5. [函数意图记录](function-contracts.jsonl)：已专门分析的函数职责、范围、限制。该清单只覆盖已列出的函数，不代表仓库所有函数都已逐个验证。
6. [逐行审查记录](../audits/2026-11-01-four-layer-recheck/README.md)：文件版本、实际阅读范围、失败和修复证据、待办。

## 模块说明

| 模块 | 说明 |
| --- | --- |
| 原生协议与连接 | [同一核心、权限继承、读写连接和生命周期](modules/native-protocol.md) |
| 消息接收与交接 | [来源、提交、接收和未知回执](modules/inbound-forwarding.md) |
| 持久状态与账号 | [版本、迁移、内存/磁盘一致性和特殊标识](modules/persistent-state.md) |
| 绑定及准入 | [精确会话边、个人/群身份和撤权](modules/bindings-access.md) |
| 目录及历史 | [原生 ID、旧别名、全部根和有界日志观察](modules/catalog-history.md) |
| 输入和控制 | [普通输入、steer、原生 queue 和写前核验](modules/input-controls.md)，[目标控制](modules/goal-controls.md) |
| 审批及提问 | [原请求、多消费者、明确答案和秘密字段](modules/native-interactions.md) |
| 系统及容量恢复 | [只读核对、恢复交接和持久补偿](modules/recovery-coordinators.md) |
| 进展、结果及渠道 | [按轮/页回执、未知不补发、复制和网络边界](modules/delivery-channels.md) |
| Web IDE | [完整 scope、原浏览器证明、90 天及独立进程](modules/ide-access.md) |
| 管理 UI | [原目标、迟到请求、原生表单和可选模块](modules/management-ui.md) |
| Taskboard | [原生执行和交互](modules/taskboard-native-execution.md)、[表单与附件交接](modules/taskboard-data-handoffs.md)、[工作流编辑](modules/taskboard-workflows.md) |
| 知识与 QA | [只读工具、实际文件边界和独立 MCP 所有权](modules/knowledge-qa.md) |
| 构建与重启 | [同一交接门禁、制品和实际运行版本核验](modules/release-lifecycle.md) |
| 四层检查与证据 | [历史、意图、逐行范围、反例和验收限制](modules/audit-method.md) |

上述说明覆盖 17 个职责模块，其中紧密关联的绑定/准入、进展/渠道合并解释跨模块边界。详细程度按真实职责组织，不建立空模板冒充完成。机器清单中的状态和设备验收限制仍独立保留。

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
| 审批消息 @ 原参与者；原生确认批准后新 AI 卡继续同一任务 | INT-01.8、INT-04.4 | [原生审批与提问](modules/native-interactions.md) |
| /sessions 按项目+session显示，保留空项目、置顶和稳定分页编号 | CAT-02.4 | [目录与历史](modules/catalog-history.md) |
| 进行中及心跳卡保留 IDE 链接；远端重连不删除固定入口 | IDE-01、IDE-09.4 | [IDE访问](modules/ide-access.md)、[结果与渠道](modules/delivery-channels.md) |
| IDE前置核验超时明确未批准；不改任务或绑定 | IDE-05.4 | [IDE访问](modules/ide-access.md) |
| 单一原生App Server、续聊权限继承、Taskboard共用原生执行与目录 | NATIVE-02.5、TB-04.2/.4 | [原生协议](modules/native-protocol.md)、[Taskboard执行](modules/taskboard-native-execution.md) |
| 重启仅保护实际消息交接；已接收任务继续，既有远端重连不锁重启 | REL-01.9、REL-02.5 | [发布与重启](modules/release-lifecycle.md) |
| systemError恢复、容量只读对账不阻塞重启或重放原输入 | REC-01.4、REC-02.4 | [恢复协调](modules/recovery-coordinators.md) |
| /stop独立复制框、连续卡片更新、分段后最终@与IDE归属 | DEL-10.1、DEL-09.3、DEL-08.4 | [结果与渠道](modules/delivery-channels.md) |
| Web区分执行完成与答复待投递；审批漏重放与可信问题快照 | DEL-01.3、INT-02.1/.2 | [管理UI](modules/management-ui.md)、[原生交互](modules/native-interactions.md) |
| 原28项补测、精确断言和剩余范围；33种流程节点的配置与执行边界 | AUDIT-01、TB-10.3 | [审查方法](modules/audit-method.md)、[节点对照](taskboard-node-contracts.md) |

功能总文档的主清单现逐项列出全部305个case（含新发现的TB-09.5失败项），与JSON身份一一对应；旧审计报告中的“当时未完成”保留其历史语境，以当前功能清单、模块说明和验证边界为准。

## 最新补测检查点

此前检查点中原28项已补直接命名测试，304case均有映射；本次另发现1个失败项尚缺正式回归，当前总数305。199窄边界通过、105部分覆盖。功能及模块文档和JSON同步更新。具体证据见../audits/2026-11-01-four-layer-recheck/2026-11-02-gap-regressions.md；[工作流节点配置/执行对照](taskboard-node-contracts.md)明确33kind仍缺的执行与授权边界。手机实机验收继续记为未完成，不是新的发布门禁。
