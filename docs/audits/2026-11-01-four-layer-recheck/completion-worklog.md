# 持续完成记录（未验收，不是完成报告）

用户最新要求：全部完成后再给最终回复。继续修复、补模块/功能文档、case与四层核对；中间仅必要进展。之前的阶段结果不能当最终验收。

线上已验证版本仍为6af92328acd1729eeb6603c4844df0817d237be5。其后以下改动尚未提交、push或部署；用户.DS_Store保留。使用隔离Chrome、模拟HTTP和临时状态，未触碰生产任务板数据、真实Codex任务或自动化开关。

## 评论部分上传与未知回执

- TaskDetail submitComment 原路径先createComment，再上传普通/内嵌附件。原版普通附件失败会清空待上传文件；内嵌失败重试可能再次创建评论。
- 当前候选捕获单次提交、已确认comment和File→Attachment回执，失败后只续传未确认文件；评论正文和已确认文件不会重发。同步ref挡同一轮重复提交。
- 提交前localStorage保存不含正文的操作ID/phase/commentId，未知网络/5xx/版本冲突要求核对；刷新后仍保留，不自动重放。结束本次提交只结束本地交接记录，不删除原评论或取消已发生的HTTP写。Files本身不宣称跨页面保存。
- 草稿持久化的组件owner与提交operation ID分开。旧组件确认不能清新组件草稿，也不能移除较新操作的receipt。当前增加了卸载/重新挂载的直接场景，仍需完成最新版验证。
- 旧组件反例：/private/tmp/taskboard-comment-before.log，18通过，两个新增失败及父失败；候选相关25项及随后33项曾通过。首轮新断言错误返回DOM，CDP报Object reference chain too long，已改Boolean，未更改业务期望。TypeScript首次联合对象推断缺comment字段，已显式约束类型。

## 主App项目视图归属

- 真实生产App入口已在浏览器fixture渲染：副本、归档、撤回恢复、新建；等待回执时切B，确认旧写仍完成，但旧UI不应插入A实体、安装A的撤回或覆盖新页面。
- 四条原版反例确认；最新旧版日志/private/tmp/taskboard-app-source-before.log：20通过、4业务失败及父失败。夹具菜单文本曾漏快捷键、键盘事件曾以window作target，已纠正并重新跑原版，不把夹具错误算产品bug。
- 当前App统一selectProjectView，所有选择/路由/初始加载更新同一project generation，代次在事件内同步变化，回切不复活旧view。清理旧view的列表、编辑器、菜单和undo。异步成功、错误、finally及undo只有原view可改当前UI，确认写留在原实体。旧undo等待不阻止新view的undo。
- 正常/换项目/ABA的4×3真实组件场景加入；ABA期间还模拟后端新版本，旧回执不得覆盖。曾33项通过（/private/tmp/taskboard-app-source-controls.log），后续同文件新增生命周期场景后出现菜单立即关闭的时序，正在定位。
- 新建议题部分上传/未知创建随后已确认3个原版反例：普通附件失败关闭编辑器丢文件、内嵌失败重试create两次、未知创建无持久记录。候选在App保留IssueCreation，确认Task与File回执，重试使用同一Task，正文变化PATCH原实体；TaskEditor显示继续保存及未知核对，结束本次提交仅清原本地记录。3原版失败日志/private/tmp/taskboard-creation-before.log，候选随后37项通过；仍需最终全量与文档映射。

## 共享浏览器回执的进一步复核

两个真实TaskDetail实例共用同议题：第一条pending，第二条确认会清掉第一条单task级回执。原版新例失败，日志/private/tmp/taskboard-receipt-ownership-before.log。现提取web/src/submissionReceipts.ts，用kind/scope/operation ID各自一条key，不做共享对象读改写；正常确认、手工核对只清自己或原快照中的keys。comments与issues共用此规则。未知read状态不当成已退休；同步ref保留review/submit边界。

comments草稿owner在实际编辑时更新，旧组件effect不覆盖新owner，确认只清自己仍拥有且未修改的草稿。重新挂载生命周期场景已通过。正文/File不存提交journal，文件跨页面恢复不作保证，页面关闭后只核对既有实体和回执，不自动复制新任务。

## 浏览器夹具与当前运行

taskboard/test/ai-chat-browser.test.mjs、helpers/ai-chat-browser/main.tsx包含真实App及评论操作fixture。新增documentId与navigate等待新文档，避免旧页面相同DOM误作ready。菜单仍偶发关闭，当前/private/tmp/taskboard-menu-diagnostic.log记录scroll/blur/resize及焦点，待看结果；不能盲重试或改产品代码凑绿。

浏览器运行命令使用CODEX_CHROME_TEST_BIN=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome，执行taskboard/test/ai-chat-browser.test.mjs。测试自己创建/清理临时profile和本机端口，须在sandbox外执行。Taskboard typecheck当前通过；未跑会刷新桌面的普通build。后续静态前端应隔离build:web并按实际HTML/JS/CSS验收发布。

菜单事件诊断捕获到board-scroll滚动恢复（focus仍body），不是旧请求插错项目；没有修改产品菜单。夹具navigate等新document ID/complete，App菜单前等字体并复位board滚动、两帧settle。最新/private/tmp/taskboard-ui-checkpoint.log全部38项通过；此前菜单偶发日志仍保留，不盲改产品。当前完整子包回归运行于/private/tmp/taskboard-completion-full.jsonl（需查exit与failed），预计仍有原Workflow2失败，不能改正则凑通过。

## 尚未完成的全局范围

继续以pending-findings.md、gateway-requirements.json及review-conclusions.md为源；283case中147窄场景通过、97partial、1failed、38缺直接测试。此处候选尚未写回这些case或新源码hash，需等最终验证更新，不能直接改散列冒充通过。

仍包括工作流两项失败、Taskboard自有exec/注入器私有RPC的统一原生接口、恢复协调器重启粒度、完整原生项目roots/unknown、更多审批来源、云端写/附件补偿、客户端排版和手机网络、安装更新、知识读写边界等。其余模块文档仍需按实际职责补齐，不能建空模板冒充完成。

## 工作流复核（本轮候选）

真实 WorkflowBoard → React Flow pointer → canonical flow → /workflow-workspace PUT。原浏览器反例 root-step/condition 不排序，计划子项正常；不能只改源码正则。当前恢复根步骤垂直拖动，条件 item 带两个 branch 整体移动，触发器保持首位，计划子项保持 parent。拖动预览不参与保存，不改变真实 canonical 顺序；放下时用 pointerdown 捕获的抓取偏移及最终坐标，避免 React Flow 合并末次 mousemove 后用前一帧落点。viewport 的范围重算也不抢拖动。

原候选诊断多次失败仍保留：workflow-drag-before/after/diagnostic/trace/fixed/drop/pointer-drop；最终 pointer-grab.log 45通过。夹具需要等待新文档、字体和viewport稳定，不把浏览器坐标错误算产品bug。

VERSION_CONFLICT 原先直接 applyWorkspace(remote) 会丢本地；候选保留本地并暂停自动保存，用户明确选择保留本地（按观察版本CAS，再冲突继续保留）或加载远端。正在加载时 tabs/add disabled、canvas inert，避免加载回执覆盖刚编辑的默认流程。project key 隔离旧保存。hydration-before 原1业务失败（controls未禁用），hydration-after 46通过，涵盖旧项目待保存时切新项目、正常/两种冲突选择和4种真实拖动。未开启原本隐藏的节点入口，不宣称任意palette执行已适配。

## 项目可写范围

实际 resolveAiWorkspace → buildCodexArgs(--add-dir) 路径原先把其他项目主目录全加入可写，忽略当前项目第二根。新真实目录/软链接夹具 ai-workspace-scope.test.mjs 原版失败，候选保所选项目所有有效真实根、去重，首根作cwd，其余仅本项目附加。设备picker仍显示首根，不以设备目录全集作权限依据。workspace-scope-after.log 10通过，旧runner正常断言移除“其他项目可写”的错误期望；无生产权限变更。

## 恢复与继承控制来源

- SystemErrorRecovery pending 包含只读snapshot，原版两个新case失败；旧首轮测试因assert失败后after等待未释放的read挂住，修夹具finally后重跑，单独 proof.log 精确2失败。清理仅准确本轮隔离测试PID60318/60362，不动Gateway/原生任务。
- Coordinator重启判定委托已有原生transport RPC drain；stop退休journal writer，不等只读pending，sourceTokens清理。save在stopped后不写，durable restoreActive先于archive写仍保留供继任者补偿。实际原生修改仍由transport.hasRestartBlockingWork保护。system-restart-read-after.log 37通过2真实native默认跳过，另最终全量将显式指定native二进制。
- Capacity checking/settling 纯snapshot不锁重启；实际 terminal/retireProjection 投递另计交接，执行接受前/终态仍保原保护。原2失败，对照检查停止后迟到查询不启动恢复、不改磁盘。
- model/effort default 已先保存继承设置再查当前值。原10个过期来源反例失败（正常2通过），候选查回后只退休旧展示，不抛成“未提交”；绑定/ABA/role/个人撤权/停止均覆盖。runtime-capacity-boundaries-after.log 共56通过（含24goal原用例）。

## Web上传与后台观察

- AccountManager.saveSessionUploads 实际上传路径原文件0644，新断言原失败。新建操作目录0700、文件0600；后续历史读取/内容及目录归属对照通过，web-upload-mode-before/after.log。只限制新建入站附件，不批量chmod用户文件。
- CodexSessionCompletionMonitor watcher 的setTimeout scanNow拒绝原无catch。隔离子进程模拟fs.watch真实触发，旧宿主unhandledRejection退出42，修后记录失败而不退出；monitor-watch-before/after.log，相关整文件通过。

## 当前回归与未上线状态

本轮仍未提交/push/部署。Taskboard真实Chrome最新46通过，两个原Workflow静态测试未改断言。Taskboard typecheck及根typecheck已过。一次在sandbox内全量出现HTTP listen EPERM及Miniflare SIGABRT，不作为产品根因；另一次误用不存在的Node json reporter启动失败，已改仓库现有audit reporter。

正在sandbox外执行：taskboard-completion-current.jsonl及gateway-completion-current.jsonl（Gateway给定0.166.0 native binary，临时Home与假模型）。baseline ledger/requirements/function contracts未重新填充当前hash，不能声称新代码逐行证据已验收。单一原生接口迁移、剩余case、模块文档及真实客户端验收仍未完成。

## 重启交接第二次核对与当前结果

Bridge 接收回执后 await onTurnStarted 跟随初始化仍持外层 RestartWork；独立轮次真正发送普通结果时外层又已放行。真实 Bridge 新两例旧版均失败（bridge-channel-drain-before.log），改为接收/身份持久化后先 acceptedWork，actual ChannelClient 写独立lease。withChannelWriteLeases列11种消息/卡片/媒体写，保持this/稳定方法；入站资源读取、路由查询、typing不算消息handoff。AccountManager给Bridge和ThreadHub共用同一包装client，使用已有resultRestartWork；不新增另一门禁。异常也释放。8条Bridge/审批/问题回归通过，11写+3读/typing及异常释放另逐项覆盖。

首次typecheck发现Reflect.apply结果unknown不是Promise，已用async边界修正；重新typecheck通过，不能把最初仅tsx运行通过当类型通过。一次account-manager整文件测试在sandbox内两个webhook本机listen EPERM，最终外部全量包含这些正常路径。

最新当前根完整回归gateway-completion-handoff.jsonl：2482通过，1Windows专用跳过。Taskboard完整taskboard-completion-storage.jsonl：409通过，1默认浏览器父跳过。单独启Chrome的taskboard-browser-storage-final.jsonl：49通过。两项原Workflow静态失败均未改断言，当前通过。仍未上线。

## 新代码自身的存储边界反例

已确认实体部分上传后再次setItem失败，原候选清掉本地实体ref，仍可能丢回执；quota两种议题和comment三反例在confirmed-retry-storage-proof.log。初轮before日志还有后续污染失败：前用例留下持久receipt使后用例被正确阻挡；夹具加入afterEach仅清本fixture的receipt/草稿，原业务断言不改，精确proof保3业务失败。修后已有实体不重写初始receipt，48项通过。

存储满发生在评论首次挂载时，原draft-owner layout effect还会使组件消失；initial-storage-before.log精确1业务失败。候选对草稿读取/owner/自动保存分别处理失败，保留当前页面输入；首次receipt无法保存时零HTTP，提示未提交，恢复存储后可显式重试。存储不可读需重新检查，不能当无pending；结束记录失败先保留原记录/草稿。首轮修后预期误忽略上一用例故意保留的草稿，修独立fixture清理后最终49通过，不当成第二个产品bug。

证据更新脚本首次与已有CHAN case ID撞号，在写requirements之前停止，已选择未用CHAN-03.6；不覆盖原case。新7个窄场景加入后共290case/256映射/159窄场景通过；基线源代码当前hash与相同行继承另更新。61个手工函数合同仍是精选函数，不是全仓函数自动证明。文档尚需刷新部分旧数字与已完成case说明。

## 本地提交检查点与下一段接口迁移

已将上述49浏览器/2482根/409子包通过的修复保存为本地提交7fbc846（完整SHA以git为准），尚未push/部署，正式线上仍6af9232。git prepare-commit-msg旧hook会覆盖英文标题并加入无关ODPS模板，首次e2c04f2标题错误，保留原Change-Id且以--cleanup=strip修正为7fbc846；未禁用或修改hook，没有改业务代码来迁就模板。

正在继续TB-04.2真实架构缺口，不宣称已迁移：AiChatService/issueAutomation和injector仍存在exec/私有RPC。先在同一根适配器补skills/list和mcpServerStatus/list，不另起目录子进程；精确cwd、有效空列表、分页重复及脱敏字段需要独立测试。native-shared-catalog-before三失败（方法缺失）；首次候选沿用不存在recordValue造成两个失败及TSunknown错误，已改用既有isRecord，当前三通过，含本机/指定remote host委托；没有接触真实MCP配置/凭据。

本机0.166.0官方二进制只执行generate-ts（不启动服务/模型），schema位于/private/tmp/gateway-native-schema-01660。ThreadStart/Resume/TurnStart确认支持runtimeWorkspaceRoots、approvalPolicy、approvalsReviewer；UserInput支持localImage。nativeSettings作为显式 owning UI选择才覆盖；正常Gateway续聊字段省略、保原权限，不根据handler存在与否推断。explicit settings的四种new/existing×inherit/explicit及非法绝对路径检查已8项合并通过，native-protocol-foundation.log。当前字段/目录新基础仍未接入Taskboard，未计入case通过/旧ledger，也尚未提交。根typecheck已通过，需后续整条集成及真实临时native协议验证。

下一步需保全Taskboard现有公开工具详情、模型/Skill/MCP目录、文件/图片、审批与提问原生往返、未知接收与跨重启恢复、显式停止；只能在连接与部署处区分桌面/CLI，不能禁用功能关闭TB-04.2。需继续完成其余模块和候选，不结束用户任务。

## 原生接口迁移的当前工作区（尚未提交/部署）

本段在7fbc846本地检查点之上；正式线上仍6af9232。新增基础已经接入Taskboard实际链路，不再仅是mock方法：AiChatService→同一根CodexAppServerGateway；自动处理器→AiChatService；模型/Skill/MCP及额度查询不再启动私有CLI助手。新增SQLite native_receipt、自动处理claim/dirty及用户事件原子事务；公开工具item稳定ID补读；原生审批/提问本地表单和秘密答案不持久化；close只detach独立任务，明确停止目标原turn。

真实隔离原生验证：native-settings-scoped-skills.log 4通过；图片首次base64夹具损坏，诊断只读本机假模型输入，换为有效PNG后通过。此后发现真实skills/list存在同名不同path合法条目，已修为name+path身份，未去重掉不同文件。taskboard-native-automation-restart.log 5通过，包含实际原生核心的UI权限、重连不重发、真实审批及自动处理dirty认领跨SQLite重开、disabled不重启用。首次审批测试错误假设必有decline，实际原生只提供cancel；已按原生返回的拒绝/取消选项验证，cancel对应interrupted，未在产品合成选项。

当前已跑一轮根完整gateway-native-unified-full.jsonl：2504通过1Windows跳过；其后又新增两个自动处理实际native场景，需最终再跑。Taskboard第一次统一后完整taskboard-native-unified-full.jsonl 411通过1默认Chrome父跳过；Chrome taskboard-native-browser.jsonl 50通过。后续补动态自动处理模型目录、缓存只读及scope/ABA后，taskboard-native-browser-catalog.jsonl 52通过，原版counterexample automation-cache-before.log保1业务失败及父失败。native-questions-automation-catalog-final.log 28通过，含flush不重放和秘密答案、原子落盘失败。两项typecheck当前通过，但后续diff仍需最终合并验证。

曾在迁移早期误启动旧exec测试夹具的全量，发现尚未注入假native端后停止自己PID43638的测试进程树，没有停止Gateway/原生服务。旧compiled dist缺新catalog方法，旧假执行器尚未适配；该次不作产品失败或通过证据。所有Ai/自动处理/目录/额度测试现均显式注入fakeNativeCore，真实协议另由临时Home+假模型测试提供；不可再让单测默认连接真实Home。

旧AiChat CLI参数/JSONL子进程测试已按实际入口改为native输入/身份/回执测试，未在生产保留exec fallback。旧测试中的SIGTERM进程组属于已经移除的Taskboard自有执行链，不再作为新路径验收；根transport自身仍有进程/pipe测试。Taskboard服务与embedded目录测试也已改注入同一协议假端，不靠调用假的debug models维持旧断言。旧审批、模型和状态业务断言仍保留或改成精确原生身份断言。

新增模块说明modules/taskboard-native-execution.md详细记录职责、状态、权限映射、原生交互、故障和未完成范围。审查JSON/ledger/function hashes尚未按这批新diff重新记录，不能用旧证据宣称当前新代码逐行已验收。

下一步必须继续：复核全部新diff及调用者；最终全量/Chrome/类型；native/Taskboard case精确映射和失效旧测试引用；其余模块文档。架构上显式私有stdio模式的Taskboard连接可能另起核心，以及同线程UI/IM多个交互观察者需特别核对，不能仅凭daemon独立连接测试说全部模式统一。旧Desktop scheduler RPC为旧Cron/窗口UI，非任务执行；不要为了“去私有RPC”伪造标准scheduler接口或禁用既有功能。

全局其余候选仍在pending-findings.md，尤其CAT-03.2完整roots/显式未知ID/同cwd多native项目与旧Desktop alias和IDE稳定授权的联合迁移，不能只去掉merge cwd去重便破坏URL/准入。ManagedSession新unknown归属、rollout长行预算、其他34未映射case及设备验收也不能遗忘。没有push、prepare/seal/switch或修改生产状态。

## 同一核心与交互多消费者的进一步修正

上一段两个架构疑点已经按实际路径处理，不能继续当“未做”：server/index→TaskboardLifecycle 注入 AccountManager.taskboardNativeBackend，嵌入端借同一个runnerFor实例，close不拥有核心。发布freeze也在借出客户端的run/interrupt最终guard核验。Taskboard不再把onApproval/onUserInput作为独占active handler传入run，而是以taskboard消费者订阅原生交互。根Facade新增NativeInteractionFanout和每thread/host串行订阅transition，同一native请求支持晚加入IM，消费者移除/替换使旧promise失效；第一份明确有效答案只提交一次，缺路线/异常不合成拒绝。UI关闭只unobserve自己的消费者，保留IM。Native schema与逻辑仍是一套，没有Desktop/headless业务分支。

auto模式原来根据自定义可执行文件basename猜stdio，已移除此隐式选择；测试假的CLI必须明确appServerTransport=stdio。AST首轮漏了一个as any包裹的测试对象，导致该反例读到了真实核心并以无效fixture线程ID在thread/read被拒，未发turn/start；已补该显式测试配置。旧失败在native-one-core-protocol-current.log及gateway-shared-native-final.jsonl保留，不算产品写入权缺陷。后续全量需重跑，旧全量这1失败不涂改为通过。

native-shared-surface-integration.log：14通过，包括真实原生Taskboard7场景、fanout4当时场景、借出核心/门禁3场景；此后又增加同ID编辑提问的fanout直接case。曾root类型检查发现Promise.withResolvers超出现有lib和联合Promise推断错误，已改显式Promise与async返回类型，native-one-core-types-fixed.log及web对应检查通过。不能只凭tsx执行通过宣称类型正确。native-one-core-taskboard-external.log 23通过；一次先在sandbox内跑同HTTP组合出现listen EPERM，外部正确运行作为证据。

Taskboard最新完整taskboard-native-current-full.jsonl：413通过1默认Chrome父跳过。浏览器最新52通过仍以taskboard-native-browser-catalog.jsonl为准；后续caption/fanout代码改动需最终复验。根gateway-shared-native-final全量正在运行，该轮已发现上述漏指定stdio的旧夹具一失败，必须修后再次全量；不要拿中途1106通过当最终结论。

新增复核事项：AiChat.startMessage对turn POST丢回执仅保留draft并解除submitting，完成较快时显式再按Enter可能再次运行；服务端原生receipt尚无浏览器请求的稳定操作ID。需要实际Chrome反例、精确HTTP操作ID/本地未知receipt与服务端原子去重/只读核对，不能以同线程running锁证明HTTP未知接收已经解决。createThread POST未知也要区分已建空线程与已提交原生任务。现未修、未计为通过。

全局CAT项目alias/roots/unknown等仍待下一阶段；新增模块文档仅native一份，其他模块说明还要逐项补充。当前所有新工作仍未commit/push/上线；7fbc846只是更早稳定本地检查点。


## 当前收敛批次：HTTP 回执、身份与底层边界

- 真实 Chrome 旧版反例：原生 turn 已完成但 POST 回执丢失，保留草稿再次 Enter 发出第二轮。现浏览器写前无正文 UUID journal、服务 SQLite 原子幂等记录与 tombstone、GET 核对原实体；未知不重发，存储满零 POST，正常拒绝仍保草稿。直接 service/真实 HTTP、完成/重开/删除/改内容和附件均有反例/对照；显式 Chrome 54 项通过。
- 两个项目身份原版反例确认按 cwd 隐藏同根不同原生 ID、失效明确 ID 误选另一个项目；新建还只传主根。修复完整 roots、明确别名、ID 保留和未知拒绝。初版 fixture 用私有 stdio 重开使假项目目录丢失，已改持久测试传输；临时目录 /var 与 /private 的正常 realpath 差异另行修正，未改变原业务断言。
- 真正新绑定 unknown 被保存为 none 已复现；现持久区分 unknown、重载不造项目、继续准确原线程不传项目覆盖。两个旧 catalog fixture 原本省略 membership 却断言 none，已补明确原生 none，未知另有直接反例。
- RuntimeState 特殊身份键 __proto__ 真实反例失败，live map 无原型，磁盘格式不变；ENOSPC 注入确认原有保存回滚有效。第一次 fixture 方法名写错已保留日志，正确入口再取得真实旧版失败。
- rollout 超长未完成单行超过 8 MiB 的 Buffer.concat 反例确认；现在只保 discard cursor，后续换行恢复正常 UTF-8 进展/完成，不把丢弃 oversized hint 当任务失败。
- 控制 action/goal form 的创建/更新未知后补新卡/正文四反例失败；Bridge 不再用异常授权补发。旧“任意更新错误都新卡”case 被新契约取代，保留新明确命令仍正常创建卡的对照。DingTalk/群渠道管理选择器不再把个人准入 ID 当群；Weixin 直接联系人保留。
- 补齐 12 份有实际职责、状态、失败和 case 的模块说明，现文档入口覆盖全部 17 职责；函数注释解释边界，不逐行翻译。知识工具真实 symlink 越界、父路径、2 MiB 与普通文档新增直接测试，原保护有效无需再改代码。

本批次保留旧版失败、夹具错误和修后运行日志，不把默认浏览器 skip 当实际浏览器通过。最终源码、case 映射、全量测试和发布记录仍需在同一提交上核对。


最终清理：rg 核对旧 buildCodexArgs/normalizeCodexEvent/spawnCodexTurn 全仓没有调用者，ai-chat-process 仅保 buildCodexPrompt，删除旧私有 CLI 执行/kill代码，避免留下第二条可调用执行路径。提示函数逐字保留，前述原生执行用例仍适用，清理后的回归另记。一次错误cwd未能执行清理，沙箱内HTTP测试无socket权限，均不作为产品失败或完成证据，已改正确绝对路径并以外部隔离运行结果为准。

清理后的 Taskboard 全量再次416通过、1默认浏览器父测试跳过；前端独立 outDir 构建完成，未触发 Desktop 注入。证据工具再次0失配。
