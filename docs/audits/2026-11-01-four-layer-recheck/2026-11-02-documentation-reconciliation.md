# 当前文档与验证边界校准（2026-11-02）

用户要求文档先做。此次以已上线业务源码afbd2d2为基准，只修改文档与审查元数据，不修改业务代码、测试断言、权限或发布门禁。

## 当前事实与历史分开

当前81条要求、310个case全部有精确测试映射；204项仅在列明边界通过、106项部分覆盖、0项登记为已确认未修复反例。0项登记不表示不存在隐藏缺陷。13项原缺少具体边界的记录现已逐条核对，全部保留partial。

修正架构索引、实现关系图、功能契约和JSON汇总中305/304旧计数及TB-09.5未修复的过期结论；中英文README、后端、Taskboard、发布和交接说明同步。历史失败、原日志、旧报告及旧汇总以历史身份保留。当前未实现、缺测、真实环境验收由[剩余清单](../../architecture/remaining-work.md)分别维护。

功能总文档另有20条场景描述与需求JSON不同，包括已有修复的项目身份、附件、回执和工作流编辑边界；现逐项同步全部310条身份及场景文本。它们是文档漂移修正，不是新增20个功能或20个已修复产品缺陷。

## 13项既有断言的边界

证据类别中的real-native表示安装的原生二进制配临时Home和本机假模型，不是真实供应商推理或真实Desktop操作。JSONL、snapshot、HTTP和受控promise分别是替身边界。下列是阅读已有断言所得，不是本轮新增运行通过记录。

### NATIVE-01.1 · 无桌面注册表也可新建、继续、跟随、交互、排队、目标和历史

已直接覆盖：实际安装的原生二进制、临时Home和本机假模型；共享核心上创建/续聊、归档/解档、暂停goal的读写清理、目录、queue消费与历史唯一client ID，以及动态工具/结构化ephemeral输出有直接断言。

仍缺：该映射没有完整验证无Desktop部署的交互、持续跟随、网络重连和全部方法组合；本机假模型不等于真实服务商或远程CLI部署验收。

断言来源（精确测试名称保留于需求JSON）：

- [test/shared-app-server-integration.test.ts 第142—165行](../../../test/shared-app-server-integration.test.ts#L142)；内容SHA-256随boundaryReview登记。
- [test/shared-app-server-integration.test.ts 第221—236行](../../../test/shared-app-server-integration.test.ts#L221)；内容SHA-256随boundaryReview登记。
- [test/fixtures/shared-native-core.mjs 第19—91行](../../../test/fixtures/shared-native-core.mjs#L19)；内容SHA-256随boundaryReview登记。

### NATIVE-02.1 · 两个客户端继续同一线程并看到同一活动轮次

已直接覆盖：真实原生核心的diagnostics PID与Gateway serverIdentity相同；peer创建线程后Gateway顺序续聊、归档/解档再续聊，queue与历史断言输入只出现一次。

仍缺：所映射主测试是顺序续聊，不包含两个写客户端同时继续同一活动轮次的竞争；不能仅凭both peers标题宣称并发写和双观察者时序均已验证。

断言来源（精确测试名称保留于需求JSON）：

- [test/shared-app-server-integration.test.ts 第142—165行](../../../test/shared-app-server-integration.test.ts#L142)；内容SHA-256随boundaryReview登记。

### NATIVE-02.2 · 有无审批回调均不重置已有工作区可写和自动审核

已直接覆盖：真实peer以never/auto_review/workspace-write创建线程；Gateway默认配置read-only但续聊未传nativeSettings且带onApproval回调，peer再次resume仍返回原审批策略、审核者和可写sandbox。

仍缺：此映射只直接断言带审批回调的续聊；无回调、显式UI覆盖、旧配置迁移与重启的组合不由这一测试证明。

断言来源（精确测试名称保留于需求JSON）：

- [test/shared-app-server-integration.test.ts 第238—250行](../../../test/shared-app-server-integration.test.ts#L238)；内容SHA-256随boundaryReview登记。

### NATIVE-02.3 · Gateway 断连重连不抢锁、不改变 core/线程/输入次数

已直接覆盖：真实原生第二轮已接收且模型受控阻塞时退休Gateway独立观察并close，重建适配器仍有同一core身份和activeTurnId；释放后原turn完成、clientUserMessageId仅一次、模型共两次调用。

仍缺：这是连接/适配器重建，不是真实Gateway进程在接收与fsync任意间隙被杀；未断言Desktop写锁、私有stdio或所有远程断线时序。

断言来源（精确测试名称保留于需求JSON）：

- [test/shared-app-server-integration.test.ts 第198—219行](../../../test/shared-app-server-integration.test.ts#L198)；内容SHA-256随boundaryReview登记。

### NATIVE-03.1 · 本地远程同 threadId 不串状态、模型和额度

已直接覆盖：真实JSONL子进程替身按remote-a/remote-b/local返回不同模型和额度；Bridge两种callback模式和AccountManager断言host/cwd/thread参数不丢失，远端故障返回错误。

仍缺：未在真实SSH核心上制造相同threadId，未以同组场景证明运行态、模型和额度全部隔离；getRuntimeInfo在此为替身。

断言来源（精确测试名称保留于需求JSON）：

- [test/host-metadata-routing.test.ts 第14—57行](../../../test/host-metadata-routing.test.ts#L14)；内容SHA-256随boundaryReview登记。
- [test/fixtures/host-metadata-app-server.mjs 第1—21行](../../../test/fixtures/host-metadata-app-server.mjs#L1)；内容SHA-256随boundaryReview登记。
- [test/account-manager.test.ts 第1602—1617行](../../../test/account-manager.test.ts#L1602)；内容SHA-256随boundaryReview登记。

### NATIVE-03.2 · 远程目录/模型读取失败不改为本机结果

已直接覆盖：公共Gateway facade经JSONL子进程请求unavailable host的model/list和account/rateLimits/read均拒绝；已连接host集合精确，不以本机模型或额度替代。

仍缺：测试替身未提供远端项目/session目录失败分支，也没有真实SSH掉线；模型/额度失败不能外推所有目录API不回退。

断言来源（精确测试名称保留于需求JSON）：

- [test/host-metadata-routing.test.ts 第14—29行](../../../test/host-metadata-routing.test.ts#L14)；内容SHA-256随boundaryReview登记。
- [test/fixtures/host-metadata-app-server.mjs 第1—21行](../../../test/fixtures/host-metadata-app-server.mjs#L1)；内容SHA-256随boundaryReview登记。

### NATIVE-03.3 · 等待期间换绑后原查询不改新会话设置

已直接覆盖：真实Bridge/RuntimeStateStore在/model new-model等待受控目录promise时切换会话或撤销个人准入；迟到响应后两个会话model都未改变，操作返回失效错误。

仍缺：该映射未包含effort/全部元数据命令、A→B→A和真实远程连接等待组合；其他case有相关对照，尚未逐一归并。

断言来源（精确测试名称保留于需求JSON）：

- [test/intent-review-control-races.test.ts 第35—60行](../../../test/intent-review-control-races.test.ts#L35)；内容SHA-256随boundaryReview登记。

### CTRL-03.1 · 重启待项/已消费/未知三种分开恢复

已直接覆盖：真实文件journal重建配合后端替身：add丢ACK按client ID找回queued，已消费项跨历史分页按ID转running/completed，只有相似正文但无ID匹配则uncertain；add总数不增加，未知项不dispatch。

仍缺：没有真实原生accept/consume与Gateway落盘之间的进程骤停、多客户端并发队列及其全部恢复交错；文件对象重建不能替代这组验证。

断言来源（精确测试名称保留于需求JSON）：

- [test/native-queue.test.ts 第12—47行](../../../test/native-queue.test.ts#L12)；内容SHA-256随boundaryReview登记。
- [test/native-queue.test.ts 第77—83行](../../../test/native-queue.test.ts#L77)；内容SHA-256随boundaryReview登记。
- [test/native-queue.test.ts 第122—143行](../../../test/native-queue.test.ts#L122)；内容SHA-256随boundaryReview登记。

### CTRL-03.3 · 已送达完成项迟到onAccepted不建新卡

已直接覆盖：原生快照端口替身分别返回completed/failed/interrupted；observeOnly队列恢复发出的onTurnStarted事件保留原精确终态，completed返回原结果，failed/interrupted返回对应错误。

仍缺：断言止于runner恢复事件，没有在同一场景里断言实际Hub/渠道对已送达完成项的迟到onAccepted零新卡；各终态全部投递时序仍待联合用例。

断言来源（精确测试名称保留于需求JSON）：

- [test/native-turn-lifecycle.test.ts 第57—69行](../../../test/native-turn-lifecycle.test.ts#L57)；内容SHA-256随boundaryReview登记。

### INT-02.3 · 断线重连原typed请求ID不变且不重发决定

已直接覆盖：真实原生执行产生待审批工具，observer关闭并重建后看到与peer相同typed request ID和thread；等待时没有resolved事件或模型重启，选择原请求拒绝项后恰有一次resolved且结果confirmed。

仍缺：没有审批决定已写但确认丢失后的再重连，也没有所有typed审批种类/多个决策者竞争或IM实际投递；不能从pending请求重放外推决定未知恢复。

断言来源（精确测试名称保留于需求JSON）：

- [test/shared-app-server-integration.test.ts 第167—196行](../../../test/shared-app-server-integration.test.ts#L167)；内容SHA-256随boundaryReview登记。

### INT-03.3 · MCP枚举/数值/布尔按schema回传，未知约束明确提示

已直接覆盖：form/openai-form解析与回包保留整数/布尔/枚举和字段名，校验范围并拒绝非法值；秘密字段、复杂schema和未知约束不扁平化；空确认仅once，登录URL和审批选项另有拒绝断言。

仍缺：当前主要是parser/typed response单元边界，未知schema的通知、四渠道表单呈现和原生完整往返没有同组覆盖；不声称所有JSON Schema均已支持。

断言来源（精确测试名称保留于需求JSON）：

- [test/elicitation.test.ts 第1—46行](../../../test/elicitation.test.ts#L1)；内容SHA-256随boundaryReview登记。
- [test/mcp-confirmation.test.ts 第1—31行](../../../test/mcp-confirmation.test.ts#L1)；内容SHA-256随boundaryReview登记。

### DEL-09.4 · Desktop专用code-comment等展示指令投影为可读结果，不裸露属性串/重复正文；围栏、引用与行内代码中的字面示例保持。覆盖进度、最终、原生@、纯文本及历史，不执行展示指令。历史图片记录2717为实际故障依据，仍需逐路径映射。

已直接覆盖：共享Markdown投影对CRLF/CR围栏、引用、行内代码保持原字节，正文code-comment属性串被移除；钉钉纯文本将CRLF精确回复围栏展开为原命令。

仍缺：这三条映射不直接断言批注正文/位置完整、无重复，也未逐一串起进度/最终/原生@/历史入口和真实客户端；原历史截图故障不能以换行测试替代。

断言来源（精确测试名称保留于需求JSON）：

- [test/full-review-presentation.test.ts 第1—21行](../../../test/full-review-presentation.test.ts#L1)；内容SHA-256随boundaryReview登记。

### REL-01.2 · Gateway退出不stop原生服务，重连同turn输入一次

已直接覆盖：与NATIVE-02.3共用真实原生断连测试：accepted后hasRestartBlockingWork为false，Gateway适配器关闭重建后core/activeTurn未变，原turn完成且输入一次。

仍缺：没有在此用例执行launchd实际重启或接收/fsync窗口骤停，私有stdio不具有这一独立保证；线上重启保留core的记录是部署验收，不替代所有崩溃组合。

断言来源（精确测试名称保留于需求JSON）：

- [test/shared-app-server-integration.test.ts 第198—219行](../../../test/shared-app-server-integration.test.ts#L198)；内容SHA-256随boundaryReview登记。

## 需要优先保留的区别

- 两个peer顺序续聊，不等于同一活动轮次的并发写。
- 连接/适配器重建，不等于进程被杀或原生accept与Gateway落盘之间骤停。
- runner发出正确终态事件，不等于实际Hub/渠道没有新建卡片。
- schema解析保类型，不等于四渠道真实表单和未知约束通知均已验收。
- 重跑通过不能解释历史一次原生queue idle观察失败或后续一次观察接续超时；两条历史限制继续保留。

## 检查与维护

核对需求JSON与人读清单的全部case身份、场景文本、汇总数量和现有源码/测试散列；校验此次引用的相对链接与13项行范围。只读check-audit-evidence仍检查证据新鲜度，不参与运行/发布门禁。

上次已上线业务版本afbd2d2的发布检查为2692项：2691通过、1项Windows专用跳过；源码类型检查及隔离编译通过，Gateway重启后独立原生核心、绑定、14份IDE授权和3个入口保留。本轮不把该上次运行冒充文档修改后新运行，也不把授权保留等同手机可达。

后续改动必须先更新需求/模块职责和精确case边界，再按真实受影响路径核对源码与静态配置。当前入口只保留当前状态，阶段记录须标明历史；不得靠在末尾追加新结论来掩盖首页旧结论。

本次静态一致性核对：81条要求、310条人读场景与JSON逐项一致，106条partial逐项入口齐全，13项引用散列/行范围有效，129个本地链接目标存在；case状态、测试映射、实现散列均未改动。此结果只支持文档一致性，不增加业务运行通过数。
