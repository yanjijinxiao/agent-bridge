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
