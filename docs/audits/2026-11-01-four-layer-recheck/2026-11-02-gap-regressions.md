# 原28项缺测补齐记录（2026-11-02）

本次补的是此前没有直接测试映射的28项；覆盖304case的映射已齐。不是把原有97项部分覆盖、手机未验或工作流节点执行器缺口一并改成完成。

当前：81项要求、304case、304项有映射、199项窄边界通过、105项部分覆盖。28项绑定59条精确命名测试；TB-10.3另逐一运行33个kind子例。

Gateway完整回归：2636通过、1项Windows专用跳过、0失败。Taskboard：466通过、0失败（含显式Chrome）。两边类型检查和隔离Taskboard前端构建通过。测试回执含当前测试文件SHA-256；原生服务试验与HTTP/平台替身分开。

## 确认并修复的缺陷

- 资源清理：bindingExpiry.stop抛错曾跳过runner.close；现在仍尝试独立关闭并汇总错误。旧反例失败，8类清理注入修后通过。
- 公开历史：原生/rollout读取将内部user-role环境信封展示为用户消息；共享已知完整信封过滤，正常用户引用保留。两条旧反例失败，修后通过。
- 审批重放：首次resume丢失审批请求后曾把订阅视为就绪；waitingOnApproval但无实际请求时保持补订阅，原host/thread不变，不代答。
- 异步提问：增量与完整快照曾混用，可信空快照不能撤销消失问题；仅校验通过的完整items替换，非法/增量保留待办。
- 管理页：缺少答复待投递状态，现在展示pending与渠道接收；与原生idle/完成分开。Chrome通过真实HTTP核对。此项是功能投影遗漏，不伪造旧失败日志。
- Taskboard：读取Skill/MCP目录失败且无旧目录时仍显示正在读取；失败提示优先于加载提示。旧反例失败，修后通过。

夹具初期错误（不支持的Feishu文件、返回DTO错误、测试未初始化真实资源、非loopback Taskboard地址等）另行修正，不列为产品缺陷。原版失败日志保留本机私有临时目录。

## 逐项证据

### NATIVE-04.2 · 只读重建始终附着原核心，不创建另一个核心

真实隔离原生服务中退休/重建轻读连接，核对同一服务PID、accepted turn、模型调用数及仅一条用户输入。

- test/shared-app-server-integration.test.ts — NATIVE-04.2: retiring a real read-only connection preserves the same native core PID, accepted turn and input count

结果：所述窄边界通过。

### STATE-01.1 · 长任务完成不覆盖期间改名/解绑

真实AccountManager长轮期间改名/解绑，完成后唯一live store与重新读盘均保留新管理状态。

- test/gap-state-contracts.test.ts — STATE-01.1: accepted long-turn completion preserves concurrent rename and explicit unbind in the sole live store and on disk

结果：所述窄边界通过。

### STATE-02.3 · 单个清理失败仍尝试其余清理

逐一注入8种独立资源stop/close失败，均尝试其余资源并终止自有入口，最后汇总错误。

- test/gap-state-contracts.test.ts — STATE-02.3: cleanup failure in bindingExpiry does not skip other independent resources or ingress abort
- test/gap-state-contracts.test.ts — STATE-02.3: cleanup failure in capacityRecovery does not skip other independent resources or ingress abort
- test/gap-state-contracts.test.ts — STATE-02.3: cleanup failure in systemRecovery does not skip other independent resources or ingress abort
- test/gap-state-contracts.test.ts — STATE-02.3: cleanup failure in nativeRequestMonitor does not skip other independent resources or ingress abort
- test/gap-state-contracts.test.ts — STATE-02.3: cleanup failure in codexSessionMonitor does not skip other independent resources or ingress abort
- test/gap-state-contracts.test.ts — STATE-02.3: cleanup failure in threadEvents does not skip other independent resources or ingress abort
- test/gap-state-contracts.test.ts — STATE-02.3: cleanup failure in runner does not skip other independent resources or ingress abort
- test/gap-state-contracts.test.ts — STATE-02.3: cleanup failure in llmWiki does not skip other independent resources or ingress abort

结果：所述窄边界通过。

### CAT-03.3 · 立即保存新threadId且标题不受渠道规则污染

真实Bridge新建经隔离原生核心，在模型结果释放前读到持久thread ID，原生标题保持干净。

- test/shared-app-server-integration.test.ts — CAT-03.3: real IM creation persists the native thread before model completion and keeps the native title free of channel instructions

结果：所述窄边界通过。

### CAT-04.1 · 支持旧event及新response两种格式并去重

旧event、新response及混合重复3格式；跨64KiB UTF8读取块的长中文/emoji行，公共history精确去重。

- test/gap-catalog-controls.test.ts — CAT-04.1: event rollout history preserves UTF-8 across stream chunks and de-duplicates public messages
- test/gap-catalog-controls.test.ts — CAT-04.1: response rollout history preserves UTF-8 across stream chunks and de-duplicates public messages
- test/gap-catalog-controls.test.ts — CAT-04.1: mixed rollout history preserves UTF-8 across stream chunks and de-duplicates public messages

结果：所述窄边界通过。

### CAT-04.2 · guardian/子agent/环境/开发者指令不进入预览

rollout/标准原生history/IM目录联合过滤完整内部信封、developer、guardian和子线程；普通用户引用保留。

- test/gap-catalog-controls.test.ts — CAT-04.2: rollout preview and public history exclude internal threads, environment and developer/guardian prompts while retaining quoted user examples
- test/gap-catalog-controls.test.ts — CAT-04.2: standard native history and IM catalog do not expose internal source or synthetic user instructions

结果：所述窄边界通过。

### CTRL-04.2 · goal内容pause/clear是文本可设置

pause/clear纯文本各一次，通过真实IM命令路径核对原host/thread的goal set payload。

- test/gap-catalog-controls.test.ts — CTRL-04.2: IM goal set sends the literal objective pause to the original host instead of executing a control
- test/gap-catalog-controls.test.ts — CTRL-04.2: IM goal set sends the literal objective clear to the original host instead of executing a control

结果：所述窄边界通过。

### AUTH-01.3 · 准入写失败不在内存放行

ACL原子rename失败的停止/运行账号两种状态；磁盘、manager、Bridge均不放行陌生个人。

- test/gap-state-contracts.test.ts — AUTH-01.3: failed ACL persistence cannot grant in-memory admission through manager or Bridge (running=false)
- test/gap-state-contracts.test.ts — AUTH-01.3: failed ACL persistence cannot grant in-memory admission through manager or Bridge (running=true)

结果：所述窄边界通过。

### INT-02.1 · 首次漏快照补订阅且不把无基线增量当完整列表

JSONL协议子进程首次丢审批重放，真实AppServerRequestMonitor补订阅原host/thread，不发输入或审批答案。

- test/gap-native-requests.test.ts — INT-02.1: native request supervision resubscribes a lost first approval replay on the same host/thread without executing or deciding

结果：所述窄边界通过。

### INT-02.2 · 空快照清理待审、非法快照不误清

原生协议完整可信空items清理已消失问题；非法summary和无关增量不清待办。

- test/gap-native-requests.test.ts — INT-02.2: validated complete native widget snapshots withdraw missing questions, while malformed snapshots and unrelated deltas retain pending work

结果：所述窄边界通过。

### DEL-01.3 · 状态报告区分已完成/未送达/未实际显示验收

真实hub+管理HTTP+隔离Chrome及IM文案联合：原生完成/idle但投递失败保留pending；渠道回执后显示已接收，不声称手机已显示。

- test/gap-management-browser.test.ts — DEL-01.3: Web and IM show a completed native turn with pending delivery separately from channel acknowledgement, never device acceptance
- test/result-delivery-lifecycle.test.ts — DEL-01.3: completed execution with failed delivery remains pending in the public status until the channel acknowledgement, without claiming device display

结果：所述窄边界通过。

### DEL-07.3 · @与IDE页脚计算后仍满足容量

1/50名中文emoji参与者，合并IDE页脚和原生@后5999/6000/6001最终UTF8字节边界，超限在任何外部写前拒绝。

- test/dingtalk-mentions.test.ts — DEL-07.3: combined UTF8 answer, native mentions and IDE footer respect the exact final normalized capacity

仍未验/未实现：自动化容量联合边界已补；真实手机钉钉当前版本渲染仍未验。

### DEL-08.3 · 子agent/guardian父元数据不归主线程或假终态

真实rollout monitor的公开摘要/工具事件经过hub→卡片；子线程继承父metadata、guardian及foreign终态不污染主任务。

- test/gap-delivery-provenance.test.ts — DEL-08.3: inherited parent metadata from guardian/child logs never projects summaries, tools or false endings into the main card

结果：所述窄边界通过。

### DEL-08.4 · 同轮次历史截图出现普通最终答案后新空卡/额外小结，按真实新输入、分段回执和最终提醒所有权区分；原生客户端截图验收独立于API成功，不把旧截图算当前验收。

真实hub、accepted input journal和audience：仅真实输入切第二段，最终回执后一次@与IDE页脚，重启/重复终态/迟到摘要不再开空卡。

- test/completion-mentions.test.ts — DEL-08.4: accepted input owns one new segment, final mention and IDE footer; duplicate final/history cannot create another empty card

仍未验/未实现：分段/最终@/页脚的自动化所有权已补；当前真实钉钉端同轮分段显示和历史截图故障的现版对照仍未验。

### DEL-09.3 · 连续更新无重复控制区、摘要不消失、大空白有明确界限

HTTPS/SDK两种真实卡片投影，每种30次答案刷新后再经历等待/恢复/重启/最终；单个停止框和IDE静态区，保留摘要并限制连续空白。

- test/dingtalk-progress-layout.test.ts — DEL-09.3: https repeated task projection keeps one control region, retained summary and bounded whitespace through restart/wait/final
- test/dingtalk-progress-layout.test.ts — DEL-09.3: sdk repeated task projection keeps one control region, retained summary and bounded whitespace through restart/wait/final

仍未验/未实现：连续协议投影和空白预算已补；真实手机模板最终视觉空白和原生控件显示仍未验。

### CHAN-03.2 · 文件名/扩展/字节原样保留并有大小预算

实际DingTalk文件客户端user/group/session三路线，5类文件精确文件名、扩展、二进制bytes及等于/超过预算。

- test/dingtalk-files.test.ts — CHAN-03.2: user preserves filename/extension and binary bytes at the exact upload limit
- test/dingtalk-files.test.ts — CHAN-03.2: group preserves filename/extension and binary bytes at the exact upload limit
- test/dingtalk-files.test.ts — CHAN-03.2: session preserves filename/extension and binary bytes at the exact upload limit

结果：所述窄边界通过。

### CHAN-03.3 · 上传成功发送失败不报告收件成功

DingTalk三路线、Feishu已实现的image、WeChat image/video/file：上传成功后业务失败/缺失或丢失发送回执必须失败，不再提交；不将尚不支持的Feishu文件能力伪造为通过。

- test/dingtalk-files.test.ts — CHAN-03.3: user upload success with rejected, missing or lost delivery acknowledgement is never recipient success or replay
- test/dingtalk-files.test.ts — CHAN-03.3: group upload success with rejected, missing or lost delivery acknowledgement is never recipient success or replay
- test/dingtalk-files.test.ts — CHAN-03.3: session upload success with rejected, missing or lost delivery acknowledgement is never recipient success or replay
- test/feishu-media.test.ts — CHAN-03.3: Feishu image upload acknowledgement cannot conceal a missing, rejected or lost message receipt
- test/media.test.ts — CHAN-03.3: WeChat image upload success cannot conceal rejected, missing or lost message acknowledgement
- test/media.test.ts — CHAN-03.3: WeChat video upload success cannot conceal rejected, missing or lost message acknowledgement
- test/media.test.ts — CHAN-03.3: WeChat file upload success cannot conceal rejected, missing or lost message acknowledgement

结果：所述窄边界通过。

### IDE-03.2 · 按真实进程身份而非PID清理不误杀

真实自有IDE helper先退出；将旧ChildProcess的数值PID模拟为测试canary PID，多次stop不发signal，真实canary仍存活。未声称OS实际发生PID复用。

- test/gap-ide-process.test.ts — IDE-03.2: an exited owned process with a reused numeric PID cannot signal an unrelated live process on repeated cleanup

结果：所述窄边界通过。

### WEB-01.3 · 重启旧页面点击写操作握手后仅执行一次

生产HTML/JS+真实HTTP服务重启+隔离Chrome旧DOM：失效token明确未提交才握手重做一次；服务已提交后模拟响应丢失，不重做。

- test/gap-management-browser.test.ts — WEB-01.3: a real old page reconnects after server restart and submits a form exactly once; a lost mutation response is not replayed

结果：所述窄边界通过。

### WEB-02.2 · 未启Taskboard不加载无效iframe，网页启用同进程启动

生产管理页原生启用按钮→HTTP→同一TaskboardLifecycle→真实嵌入服务；禁用无iframe src，启用一次且Gateway PID不变。

- test/gap-management-browser.test.ts — WEB-02.2: disabled Taskboard does not load an iframe; the native enable button starts the embedded service inside the same Gateway process

结果：所述窄边界通过。

### WEB-02.3 · 标题、长ID、IDE按钮窄屏可换行无溢出

生产管理页在375px Chrome中逐视图检查、长标题/ID、IDE按钮、所有含form的dialog边界；不是手机设备验收。

- test/gap-management-browser.test.ts — WEB-02.3: actual Gateway management views, long identifiers, forms and IDE buttons fit a 375px Chrome viewport

仍未验/未实现：实际生产管理页375px Chrome及全部表单已补；真实手机浏览器/键盘/字体环境仍未验。

### TB-01.1 · 同路径不同host不关联错误项目

真实TaskboardWorkbench联合HTTP客户端映射：只有远端同路径不显示/不评论；加入本机项目后仅映射本机并按原thread评论。

- test/gap-taskboard-contracts.test.ts — TB-01.1: the real Taskboard workbench never maps a same-path remote project or writes through its issue

结果：所述窄边界通过。

### REL-02.3 · 上线后构建号/绑定/准入/浏览器grant/IDE全核对，不称push即上线

实际release命令在隔离Git/launchd/HTTP边界执行10种结果，检查build、绑定、ACL、grant、IDE、90天期限和渠道连接；失败回滚代码不复活旧授权。

- test/release-rollback-recovery.test.ts — REL-02.3: actual release switch checks build, bindings, ACL, browser grants and IDE through success
- test/release-rollback-recovery.test.ts — REL-02.3: actual release switch checks build, bindings, ACL, browser grants and IDE through rollback
- test/release-rollback-recovery.test.ts — REL-02.3: actual release switch checks build, bindings, ACL, browser grants and IDE through changed-owner
- test/release-rollback-recovery.test.ts — REL-02.3: actual release switch checks build, bindings, ACL, browser grants and IDE through restored-offline
- test/release-rollback-recovery.test.ts — REL-02.3: actual release switch checks build, bindings, ACL, browser grants and IDE through binding-changed
- test/release-rollback-recovery.test.ts — REL-02.3: actual release switch checks build, bindings, ACL, browser grants and IDE through acl-changed
- test/release-rollback-recovery.test.ts — REL-02.3: actual release switch checks build, bindings, ACL, browser grants and IDE through grant-changed
- test/release-rollback-recovery.test.ts — REL-02.3: actual release switch checks build, bindings, ACL, browser grants and IDE through endpoint-changed
- test/release-rollback-recovery.test.ts — REL-02.3: actual release switch checks build, bindings, ACL, browser grants and IDE through ttl-changed
- test/release-rollback-recovery.test.ts — REL-02.3: actual release switch checks build, bindings, ACL, browser grants and IDE through connection-lost

仍未验/未实现：隔离发布全链路反例已补，每次上线仍必须独立核对真实构建/状态；手机入口可达性及渲染不由此认证。

### AUDIT-01.1 · 每需求有具体可执行case和结果而非只列测试文件

实际只读checker反例：仅文件、错名、未运行或失败记录不能支持verified；精确同版本命名通过才支持。该测试不证明所有产品case完整。

- test/gap-audit-evidence.test.ts — AUDIT-01.1: a verified requirement needs exact named assertions and their passing result, not a test file list

仍未验/未实现：304case均已有具体测试映射；部分场景的人工或未实现边界仍保留partial，不把映射齐全算全部功能验收。

### AUDIT-01.2 · 阅读记录含内容hash/范围/职责推演，改动后失效

实际checker临时仓库反例：实现改动使旧hash阅读和测试失效，越EOF范围与空职责笔记被拒绝。仅审计产物合同。

- test/gap-audit-evidence.test.ts — AUDIT-01.2: changed content invalidates old line coverage and test evidence; invalid ranges or missing intent are rejected

结果：所述窄边界通过。

### AUDIT-01.3 · 原版失败/修后回归/真实协议/客户端验收分别报告

实际checker保留原失败/最新修后通过，测试改动失效；全绿仍报in-progress，不声称真实协议或手机验收。真实原生、协议夹具、API替身、Chrome另分类。

- test/gap-audit-evidence.test.ts — AUDIT-01.3: prior failure, fixed pass and stale tests stay distinguishable; clean metadata cannot certify real protocol or phone acceptance

结果：所述窄边界通过。

### AUDIT-01.4 · 历史图片逐张本机查看并记录可恢复/缺失范围；图片中引用的其他仓库任务、旧命令和秘密不转成新执行指令或功能要求；仅公开历史进入需求来源。

历史manifest明确92可读/5丢失且不是当前客户端验收；实际Bridge把引用/围栏中的stop/allow/queue与附件示例当本轮分析数据，无控制写入。

- test/gap-audit-evidence.test.ts — AUDIT-01.4: historical missing-image boundaries are explicit and quoted attachment commands remain task data, never control actions

仍未验/未实现：引用命令惰性及manifest边界有自动化；原先92张逐张观看属手工记录，5张缺失仍不能重读，自动化不冒充视觉阅读。

### TB-10.3 · 各palette kind逐一对照实际执行支持/必填字段/授权来源，动态Skill与MCP失败不能伪造可用选项。

逐一执行33种palette配置校验，必填分支和动态Skill/MCP失败、旧选项不可用；真实能力HTTP目录失败返回500无伪造列表。流程文档保存与节点执行分开，详见taskboard-node-contracts.md。

- test/gap-taskboard-contracts.test.ts — TB-10.3: every palette kind has an explicit configuration boundary, and failed Skill/MCP discovery cannot invent ready options

仍未验/未实现：33kind的编辑配置合同已补；当前工作流服务只版本化保存文档，没有按各kind执行、凭据授权和运行回执的统一执行器。不能宣称33种节点可执行；不为此开放隐藏入口或禁用已有功能。

## 验收边界

真实隔离原生服务：NATIVE-04.2/CAT-03.3核对同一原生core及提前身份。INT-02使用JSONL原生协议子进程注入漏重放，不声称真实供应商网络已故障重现。

真实Chrome：生产管理HTML/JS、真实HTTP服务重启、真实嵌入Taskboard、375px及全部表单；响应丢失在浏览器fetch收到真实提交结果后注入。不是手机实机。

渠道媒体与卡片：运行生产客户端/投影，替身只承担外部API；UTF8容量和平台业务回执通过，不代表真实钉钉应用已显示。

AUDIT四项只验证证据产物与引用惰性；不能用审计脚本通过代替产品场景通过。92张历史图片阅读是已记录的手工事实，5张缺失继续标注，未重造验收。

Taskboard工作流文档与执行分离：33kind编辑配置已测，逐kind执行和凭据授权仍未实现；详见../../architecture/taskboard-node-contracts.md。

上线身份及实际授权/绑定保留另随release验收，不以Git push或本报告声称已上线。
