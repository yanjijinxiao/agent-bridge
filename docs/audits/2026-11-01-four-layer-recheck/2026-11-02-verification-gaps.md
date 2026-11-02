# 尚缺验证和部分覆盖逐项清单（2026-11-02）

来源：docs/architecture/gateway-requirements.json。当前共 301 个 case；28 项没有直接测试映射，97 项只覆盖部分条件。新增 CAT-02.4 的9例属于窄边界验证，不能把其余缺口改成通过。

原清单中的旧提交号或旧授权数量属于当时记录，不代表当前线上状态。

没有直接测试映射不等于已确认有 bug，也不等于相关模块从未测试。partial 中已有测试只能证明下面记录的边界；原生协议夹具、本机 Chrome、平台 API 成功和手机实际显示分别计，不互相替代。

## “手机实机验证”指什么

在真实手机钉钉中观察并操作卡片，以及从该手机打开项目 Web IDE。此前没有记录机型、系统版本和钉钉版本的这轮验收结果，因此不能宣称手机端通过。它不要求用户授予新的执行权限，也不是新增发布门禁。

以下为仍需手机观察的组合，不代表每项都没有自动化测试：

- 进展卡：首次投放 → 连续刷新 → 最终收尾；加载状态、正文保留、@ 与 IDE 页脚。
- 同一任务分段：普通补充输入、审批成功后新 AI 卡、旧卡收尾与最终结果归属，检查是否出现重复卡/空卡。
- 审批：原发起人被 @、允许一次/会话范围、拒绝或提交失败，检查完整审批回复与结果反馈。
- 复制：单项完整回复的文本框/复制按钮、复制反馈；复制本身不提交答案、不执行命令。
- 会话目录：项目+会话、空项目、跨页/改页数、远端同名项目、复制切换命令与详情（当前钉钉模板不提供原生会话选择按钮）。
- 排版：长中文标题、长 ID、代码块及链接换行、连续更新后空白区域；具体 iOS/Android 客户端差异没有本轮记录。
- 手机 → Web IDE：固定 HTTPS 入口、已有授权复用、到期处理、WebSocket 连接和重连；Mac 本机连通不代表手机可达。

## 没有直接测试映射的项目

- NATIVE-04.2 · Codex原生协议与连接：只读重建始终附着原核心，不创建另一个核心

  待补：已有reader退休/重建试验，但缺真实服务core身份、pid及输入计数不变的独立断连试验。

- STATE-01.1 · 持久状态与账号：长任务完成不覆盖期间改名/解绑

  待补：需在实际长轮完成前后并发rename/unbind，断言磁盘和唯一live owner都保留新修改；普通状态CRUD不足以证明。

- STATE-02.3 · 持久状态与账号：单个清理失败仍尝试其余清理

  待补：需逐个注入close/stop失败并断言所有独立资源均被尝试清理；正常stopAll不足。

- CAT-03.3 · 目录与历史：立即保存新threadId且标题不受渠道规则污染

  待补：需经实际新建入口验证thread创建早回执持久化和干净标题，不能用旧exec身份测试代替。

- CAT-04.1 · 目录与历史：支持旧event及新response两种格式并去重

  待补：历史读取已有多格式测试，但尚未逐一把两种格式/重复记录/UTF8长行的实际断言映射到此完整场景。

- CAT-04.2 · 目录与历史：guardian/子agent/环境/开发者指令不进入预览

  待补：父子来源和内部消息过滤分散于多个reader，需原生公共history及rollout两条路径的联合矩阵。

- CTRL-04.2 · 输入和控制编排：goal内容pause/clear是文本可设置

  待补：goal form正常例不等于pause/clear作为纯文本的精确场景；需记录实际set payload。

- AUTH-01.3 · 准入与角色：准入写失败不在内存放行

  待补：准入unknown持久保留已覆盖，但需实际ACL保存失败后manager与Bridge内存读取均不放行的精确反例。

- INT-02.1 · 提问与审批：首次漏快照补订阅且不把无基线增量当完整列表

  待补：旧Desktop monitor快照重订阅测试不能替代当前AppServerRequestMonitor的首次快照丢失场景。

- INT-02.2 · 提问与审批：空快照清理待审、非法快照不误清

  待补：需在当前标准原生请求入口验证可信空快照清理与非法快照不清理；旧IPC快照覆盖不算完成。

- DEL-01.3 · 进展和结果交付：状态报告区分已完成/未送达/未实际显示验收

  待补：API回执已分离，但Web/IM面向用户的状态文案还需联合核验；客户端实际显示未验不能声称已看见。

- DEL-07.3 · 进展和结果交付：@与IDE页脚计算后仍满足容量

  待补：UTF8分页、@、IDE分别有例；最终合并后边界容量的联合场景尚缺，真实手机展示也未验。

- DEL-08.3 · 进展和结果交付：子agent/guardian父元数据不归主线程或假终态

  待补：已有native父子身份过滤，仍需经过实际公开summary/工具进展→卡片的完整来源矩阵。

- DEL-08.4 · 进展和结果交付：同轮次历史截图出现普通最终答案后新空卡/额外小结，按真实新输入、分段回执和最终提醒所有权区分；原生客户端截图验收独立于API成功，不把旧截图算当前验收。

  待补：旧图确认用户反馈，不能作为现版本验收；需真实钉钉当前版本同turn分段/最终@/页脚联合重现。

- DEL-09.3 · 进展和结果交付：连续更新无重复控制区、摘要不消失、大空白有明确界限

  待补：语义围栏和累计进展已有测试，但正文连续替换、控制区去重和大空白界限尚无完整联合断言。

- CHAN-03.2 · IM适配和网络：文件名/扩展/字节原样保留并有大小预算

  待补：实际DingTalk文件客户端已有正常/限额用例，待将各type及精确byte-budget断言逐一绑定，不能只凭名称认定。

- CHAN-03.3 · IM适配和网络：上传成功发送失败不报告收件成功

  待补：媒体journal结果已修，上传/发送阶段所有业务失败及未知回执还需跨渠道逐项映射。

- IDE-03.2 · IDE运行与浏览器访问：按真实进程身份而非PID清理不误杀

  待补：已有真实guardian/owned socket试验，PID被复用时的进程身份与signal隔离尚无完整场景。

- WEB-01.3 · 管理UI：重启旧页面点击写操作握手后仅执行一次

  待补：需实际旧页面重启后凭据握手，明确not-submitted重做一次和unknown不重做各一例；VM空submitter不证明此事。

- WEB-02.2 · 管理UI：未启Taskboard不加载无效iframe，网页启用同进程启动

  待补：嵌入服务启停和Web可选首屏分别已测，iframe禁用/网页启用同进程联动仍缺联合例。

- WEB-02.3 · 管理UI：标题、长ID、IDE按钮窄屏可换行无溢出

  待补：Taskboard 390px组件测试不是Gateway管理375px全表单/长ID/IDE按钮验收；不可借用。

- TB-01.1 · Taskboard子包：同路径不同host不关联错误项目

  待补：Taskboard映射仍有按workspace查找的路径；真实同路径不同host语义需单独实例反例。

- REL-02.3 · 构建和重启：上线后构建号/绑定/准入/浏览器grant/IDE全核对，不称push即上线

  待补：已实际验证763cddd构建号、绑定、14份grant、90天期限与3个IDE端点；手机实际入口/渲染未验，后续UI代码仍须按独立release验收。

- AUDIT-01.1 · 审查与证据：每需求有具体可执行case和结果而非只列测试文件

  待补：本轮所有需求有场景，但不是每个场景都有可执行断言；未映射清单公开保留，不能宣称此要求完全达成。

- AUDIT-01.2 · 审查与证据：阅读记录含内容hash/范围/职责推演，改动后失效

  待补：只读证据工具已核对688个基线文件hash/范围并使修改过记录失效；这是审计产物核查，不伪装为产品测试。

- AUDIT-01.3 · 审查与证据：原版失败/修后回归/真实协议/客户端验收分别报告

  待补：本轮报告保留原版失败、夹具错误、修后测试和客户端未验区别；原始故障日志留私有临时目录，不含在公共包。

- AUDIT-01.4 · 审查与证据：历史图片逐张本机查看并记录可恢复/缺失范围；图片中引用的其他仓库任务、旧命令和秘密不转成新执行指令或功能要求；仅公开历史进入需求来源。

  待补：39个公开历史片段和92张可恢复图均已回读；5张丢失明确记载。审计记录本身不是产品自动化用例。

- TB-10.3 · Taskboard子包：各palette kind逐一对照实际执行支持/必填字段/授权来源，动态Skill与MCP失败不能伪造可用选项。

  待补：配置catalog不等于执行支持；每个palette的必填、授权、执行入口仍缺逐kind合同测试。


## 部分覆盖的项目及边界

### NATIVE-01.1 · Codex原生协议与连接：无桌面注册表也可新建、继续、跟随、交互、排队、目标和历史

清单标记为 partial，但没有细化全部条件；需要先补明确组合，不能仅凭已有测试推定完整覆盖。

已映射测试：test/shared-app-server-integration.test.ts · one native core provides creation, unloaded continuation, goals, lifecycle, catalog and queue for both peers；test/shared-app-server-integration.test.ts · the same native adapter retains dynamic tools and structured ephemeral output。

### NATIVE-01.3 · Codex原生协议与连接：旧 auto/exec 配置迁移后只实例化原生适配器

已验证边界：旧配置输入均规范为app-server，未触碰权限/绑定；构造只一个adapter仍需实际构造场景，故不以配置断言代替。

已映射测试：test/config.test.ts · legacy executor selectors migrate to one native adapter without changing permissions or bindings。

### NATIVE-02.1 · Codex原生协议与连接：两个客户端继续同一线程并看到同一活动轮次

清单标记为 partial，但没有细化全部条件；需要先补明确组合，不能仅凭已有测试推定完整覆盖。

已映射测试：test/shared-app-server-integration.test.ts · one native core provides creation, unloaded continuation, goals, lifecycle, catalog and queue for both peers。

### NATIVE-02.2 · Codex原生协议与连接：有无审批回调均不重置已有工作区可写和自动审核

清单标记为 partial，但没有细化全部条件；需要先补明确组合，不能仅凭已有测试推定完整覆盖。

已映射测试：test/shared-app-server-integration.test.ts · Gateway continuation inherits the peer's permissions and reviewer instead of deriving them from callback presence。

### NATIVE-02.3 · Codex原生协议与连接：Gateway 断连重连不抢锁、不改变 core/线程/输入次数

清单标记为 partial，但没有细化全部条件；需要先补明确组合，不能仅凭已有测试推定完整覆盖。

已映射测试：test/shared-app-server-integration.test.ts · Gateway disconnect after acceptance does not interrupt a peer-visible native turn or repeat its input。

### NATIVE-03.1 · Codex原生协议与连接：本地远程同 threadId 不串状态、模型和额度

清单标记为 partial，但没有细化全部条件；需要先补明确组合，不能仅凭已有测试推定完整覆盖。

已映射测试：test/host-metadata-routing.test.ts · model and account queries use the selected native host and never substitute the local account；test/host-metadata-routing.test.ts · IM model, effort and balance queries preserve the bound remote scope (callbacks=false)；test/host-metadata-routing.test.ts · IM model, effort and balance queries preserve the bound remote scope (callbacks=true)；test/account-manager.test.ts · model callbacks keep the remote host, workspace and thread through AccountManager。

### NATIVE-03.2 · Codex原生协议与连接：远程目录/模型读取失败不改为本机结果

清单标记为 partial，但没有细化全部条件；需要先补明确组合，不能仅凭已有测试推定完整覆盖。

已映射测试：test/host-metadata-routing.test.ts · model and account queries use the selected native host and never substitute the local account。

### NATIVE-03.3 · Codex原生协议与连接：等待期间换绑后原查询不改新会话设置

清单标记为 partial，但没有细化全部条件；需要先补明确组合，不能仅凭已有测试推定完整覆盖。

已映射测试：test/intent-review-control-races.test.ts · late model lookup cannot change settings after rebind；test/intent-review-control-races.test.ts · late model lookup cannot change settings after revoke。

### NATIVE-05.2 · Codex原生协议与连接：旁路历史 interrupted 不结束原生仍 active 的卡

已验证边界：原生队列恢复不按旁路interrupted结束原生轮，非所有rollout→hub交错。

已映射测试：test/native-queue.test.ts · foreign interrupted history is identity only; authoritative observation=inProgress；test/native-queue.test.ts · foreign interrupted history is identity only; authoritative observation=unknown；test/native-queue.test.ts · foreign interrupted history is identity only; authoritative observation=completed。

### NATIVE-06.3 · Codex原生协议与连接：通信恢复沿原 turn 继续，不重放输入

已验证边界：持久binding、只读sync恢复、同handle的notice跨重启和新进展已验证；本case的真实外部连接断开后重连原运行turn仍需独立场景。

已映射测试：test/session-owner-recovery.test.ts · dingtalk: a persisted unloaded binding survives sync and ordinary messages continue the same session；test/session-owner-recovery.test.ts · weixin: a persisted unloaded binding survives sync and ordinary messages continue the same session；test/session-owner-recovery.test.ts · feishu: a persisted unloaded binding survives sync and ordinary messages continue the same session；test/codex-turn-recovery.test.ts · retry notice survives restart on the same handle and clears on real progress。

### IN-01.2 · 消息接收与交接：引用里的 /stop 或 /approve 不是新命令

已验证边界：引用审批和当前命令分离已有实际适配/Bridge断言；引用/stop全部消息类型尚无同组精确场景。

已映射测试：test/inbound-references.test.ts · DingTalk separates current command from a quoted file and keeps credentials opaque；test/ide-approval.test.ts · quoted approval text in a group is data, not a registered human decision。

### IN-01.3 · 消息接收与交接：四种渠道共用分发语义，任务/知识扩展仅在明确模式内生效

已验证边界：四渠道普通消息及显式help覆盖；所有任务/QA扩展组合未完整核验。

已映射测试：test/bridge-service.test.ts · dingtalk: ordinary language bypasses AI controls while explicit help still works；test/bridge-service.test.ts · weixin: ordinary language bypasses AI controls while explicit help still works；test/bridge-service.test.ts · feishu: ordinary language bypasses AI controls while explicit help still works；test/bridge-service.test.ts · wecom: ordinary language bypasses AI controls while explicit help still works。

### IN-02.1 · 消息接收与交接：提交前崩溃后平台重投或恢复只执行一次

已验证边界：真实隔离子进程骤停和durable inbox恢复，派发后端替身；不证明供应商全部重投窗口。

已映射测试：test/forwarding-inbox.test.ts · concurrent redelivery dispatches one native input；test/forwarding-inbox.test.ts · abrupt process death preserves the body and exact received forwarding boundary；test/forwarding-inbox.test.ts · a command durably saved before dispatch resumes once after restart, including during a release freeze。

### IN-02.2 · 消息接收与交接：原生接收后落盘前断连保留未知，不重发

已验证边界：真实持久记录/恢复和落盘故障；后端回执由fixture触发，未模拟真实服务在accept与fsync之间骤停。

已映射测试：test/forwarding-inbox.test.ts · accepted input is never resubmitted after a transport failure and restart；test/forwarding-inbox.test.ts · ambiguous input is never resubmitted after a transport failure and restart；test/forwarding-inbox.test.ts · a crash with a submitting receipt becomes visibly unconfirmed and never authorizes replay；test/forwarding-inbox.test.ts · failed acceptance persistence cannot erase the saved body or make in-memory acceptance stronger than disk。

### IN-03.3 · 消息接收与交接：上一条慢结果投递不把下一条误判为提交中

已验证边界：证明已接收执行等待不占交接；专门卡住最终投递而非执行的组合未在此测试。

已映射测试：test/forwarding-inbox.test.ts · accepted native execution does not occupy transport capacity or hold later messages until completion。

### IN-04.2 · 消息接收与交接：普通正文中的人名和 @ 不任意删除

已验证边界：适配器text/richText矩阵保正文中@和引用、inline code，不把人名随意删掉；其他渠道别名矩阵未同组覆盖。

已映射测试：test/dingtalk.test.ts · DingTalk group mentions preserve slash command routing without changing ordinary messages。

### IN-05.1 · 消息接收与交接：纯图、混排、普通文件及引用文件保留原语义

已验证边界：真实解析和共享引用缓存；各渠道纯图/混排全组合与手机原始事件尚未穷尽。

已映射测试：test/inbound-references.test.ts · DingTalk separates current command from a quoted file and keeps credentials opaque；test/inbound-references.test.ts · shared client resolves both direct and quoted media once, including Weixin mixed replies。

### IN-05.2 · 消息接收与交接：只有文件名或引用ID时明确缺内容

已验证边界：钉钉引用只有名称/无下载凭据明确标缺内容，正常直接文件/链接仍解析；其他渠道另需场景。

已映射测试：test/inbound-references.test.ts · DingTalk reports unavailable quoted files honestly and decodes direct files/links。

### IN-05.3 · 消息接收与交接：下载超限、超时、存储失败不静默丢消息

已验证边界：无长度读流限额及Bridge明确下载失败不启动空轮；各渠道存储失败/总时限组合未全覆盖。

已映射测试：test/inbound-references.test.ts · streaming downloads enforce the limit even without Content-Length；test/bridge-service.test.ts · replies directly when a WeChat attachment exceeds 100 MiB；test/bridge-service.test.ts · replies directly when an image cannot be downloaded and does not start an empty turn。

### IN-06.1 · 消息接收与交接：远程 Codex 收到远端可读附件路径

已验证边界：实际Bridge准备远端转存路径，远端存储与runner为替身；未在真实SSH主机读取。

已映射测试：test/inbound-references.test.ts · Bridge checks actor ACL before reference reads/downloads and stages quoted files for the selected remote backend。

### IN-06.2 · 消息接收与交接：转存中途换绑/撤权后不提交

已验证边界：附件准备结束后线程/角色/准入复核；远端实际SSH转存中撤权的独立场景仍需补。

已映射测试：test/transparent-forwarding.test.ts · ordinary IM rechecks thread after attachment preparation；test/transparent-forwarding.test.ts · ordinary IM rechecks role after attachment preparation；test/transparent-forwarding.test.ts · ordinary IM rechecks access after attachment preparation。

### IN-06.3 · 消息接收与交接：远程输出未提供下载通道时明确失败，不误读本地同名文件

已验证边界：已复核实际source对remote没有下载通道的明确反馈；不能把仅媒体done修复外推remote字节全链路。

已映射测试：test/turn-result-actions.test.ts · real Bridge media remote is recorded done only with a confirmed file receipt。

### STATE-01.3 · 持久状态与账号：损坏关键文件拒绝加载并保留原件，不当空表覆盖

已验证边界：关键inbox/journal坏文件保原件，不外推RuntimeState所有迁移map均已验证。

已映射测试：test/forwarding-inbox.test.ts · inbox corruption fails closed and leaves the original bytes intact；test/inbound-receipts.test.ts · journal corruption fails closed instead of rebuilding an empty deduplication history。

### STATE-02.1 · 持久状态与账号：停止再启动只有一个状态写者和发送客户端

已验证边界：实际账号启动/刷新及独立停止，但monitor/runner替身，不证明所有并发清理异常。

已映射测试：test/account-manager.test.ts · starts and stops multiple accounts independently；test/account-manager.test.ts · refreshes a running account so new credentials take effect。

### STATE-02.2 · 持久状态与账号：旧连接回执不能写入新连接或新机器人

已验证边界：已覆盖退休入站claim和机器人IDE身份；其他旧连接异步回执仍需逐条核对。

已映射测试：test/account-manager.test.ts · a retired monitor cannot report an unsaved input as an already durable duplicate；test/ide-approval.test.ts · a still-running old bot connection cannot borrow a replacement bot's registered owner identity。

### STATE-03.2 · 持久状态与账号：迁移不扩大权限、不清空授权、不重发任务

已验证边界：配置和receipt迁移保既有权限和去重；全部旧IDE/账号/JSON状态格式尚无统一迁移矩阵。

已映射测试：test/config.test.ts · legacy executor selectors migrate to one native adapter without changing permissions or bindings；test/inbound-receipts.test.ts · legacy processed IDs migrate as tombstones, while independent account journals retain their own scope。

### STATE-03.3 · 持久状态与账号：日志及管理响应不输出 Secret/Token/ticket

已验证边界：账号API和webhook投影不输出原token/key；全仓错误日志泄密边界尚未穷尽。

已映射测试：test/account-manager.test.ts · adds redacted enterprise channels and stops them cleanly；test/account-manager.test.ts · persists channel settings without exposing the webhook URL；test/account-manager.test.ts · mirrors each inbound channel message to its configured webhook。

### BIND-01.2 · 绑定与交互目标：重启、模式切换不接回旧 session

已验证边界：detach持久、模式槽位与显式新建不复活旧关系；Gateway真实进程重启另需端到端。

已映射测试：test/session-unbinding.test.ts · /unbind: detach persists with project selection, clears QA and normal slots, preserves other chats；test/session-unbinding.test.ts · /leave: detach persists with project selection, clears QA and normal slots, preserves other chats；test/session-unbinding.test.ts · explicit new rebinds without reviving the old session; unbind also works when session mode is disabled。

### BIND-01.3 · 绑定与交互目标：解绑一群不删除线程、不停止任务、不取消原生队列、不影响别群

已验证边界：真实关系事务和订阅集合，不调用runner；原生任务/queue持续执行用替身零调用证明，非真实执行中重启。

已映射测试：test/account-manager.test.ts · web unbind removes only the selected account/chat edge and immediately refreshes native subscriptions；test/session-unbinding.test.ts · exact unbind compares host, thread, conversation and current record; stale views cannot detach a replacement。

### BIND-02.1 · 绑定与交互目标：独立 session 残留旧项目仍可正常续聊

已验证边界：旧项目漂移保独立绑定，四渠道项目命令不覆盖；普通真实native续聊权限另证。

已映射测试：test/runtime-state.test.ts · legacy project drift preserves the explicit independent session binding；test/session-unbinding.test.ts · dingtalk: project-only commands cannot silently select a project over an independent native binding；test/session-unbinding.test.ts · weixin: project-only commands cannot silently select a project over an independent native binding；test/session-unbinding.test.ts · feishu: project-only commands cannot silently select a project over an independent native binding；test/session-unbinding.test.ts · wecom: project-only commands cannot silently select a project over an independent native binding。

### BIND-02.2 · 绑定与交互目标：换项目/模式使原输入租约失效

已验证边界：真实scope generation，模式session切换ABA不复活；其他任意项目变更由来源测试另核。

已映射测试：test/full-review-controls.test.ts · switching to another mode's native session and back cannot revive an old execution lease。

### BIND-03.1 · 绑定与交互目标：新旧绑定不串进度/最终结果/附件

已验证边界：hub旧绑定结果/卡关闭；附件及全部handler路径未在该测试。

已映射测试：test/thread-event-hub.test.ts · switching binding during an active stream closes the old card and follows only the new task。

### BIND-03.2 · 绑定与交互目标：归档暂停跟随而非伪造失败答复

已验证边界：archive不造final已断言；archive之后全部订阅资源暂停不由此单例证明。

已映射测试：test/thread-event-hub.test.ts · archived observations never become a synthetic final result。

### BIND-03.3 · 绑定与交互目标：准备附件或等待后端时变化在原生写入前再拒绝

已验证边界：实际显式queue/steer准备后来源守卫，全部降权/停账号组合仍待。

已映射测试：test/attachment-source-binding.test.ts · queue-download: a replaced source binding cannot retarget the prepared attachment；test/attachment-source-binding.test.ts · steer-staging: a replaced source binding cannot retarget the prepared attachment。

### BIND-04.3 · 绑定与交互目标：恢复路由后新读原题仍有效才发，不重放旧答案

已验证边界：旧Desktop兼容monitor路径的鲜活snapshot重路由，不是当前标准AppServerRequestMonitor入口全验证。

已映射测试：test/codex-desktop-request-monitor.test.ts · an unrouted question is retried only after a fresh native snapshot and then submitted once。

### CAT-02.2 · 目录与历史：旧卡/过期快照不把编号解释成另一项目

已验证边界：旧项目按钮不按新下标改投；15分钟过期与R所有别名场景另需测试。

已映射测试：test/intent-review-choice-identity.test.ts · a project button from an earlier list cannot silently target the new row at the same index。

### CAT-02.3 · 目录与历史：同主机同路径不同项目、跨主机同名均区分

已验证边界：跨host同名/同projectID分组隔离；同host同roots多个native身份创建仍是独立未决项。

已映射测试：test/session-catalog-order.test.ts · duplicate names and identical project IDs on different hosts remain separate contiguous groups；test/session-catalog.test.ts · native project membership, remote host isolation, and unavailable-host warnings survive selection。

### CAT-03.1 · 目录与历史：无当前项目不自动选第一个

已验证边界：实际fresh账号无项目普通消息/new不暗选第一项；task/qa/mode精确新反例另见CAT-03.5。

已映射测试：test/bridge-service.test.ts · authorized WeChat can add, list, and switch Codex projects。

### CAT-04.3 · 目录与历史：最近历史和翻页都保留正文/引用但不触发附件发送

已验证边界：展示引用/字面附件不发送，全部历史分页API及native格式组合仍待映射。

已映射测试：test/account-manager.test.ts · keeps source citations in session history without fabricated attachments；test/history-attachment-literals.test.ts · displayed history preserves inert attachment source examples: `；test/history-attachment-literals.test.ts · displayed history preserves inert attachment source examples: >；test/history-attachment-literals.test.ts · displayed history preserves inert attachment source examples: -；test/history-attachment-literals.test.ts · a real top-level attachment is extracted without consuming an earlier fenced example；test/history-attachment-literals.test.ts · Desktop attachment envelopes strip real image metadata while retaining the same tag in a fenced example。

### CTRL-01.1 · 输入和控制编排：expectedTurnId必带且回执thread/turn均精确

已验证边界：真实JSONL预期turn比较和Bridge默认steer，ACK中的全部thread/turn反例未在这组穷尽。

已映射测试：test/codex-app-server.test.ts · steers an active turn with an expected-turn compare guard；test/codex-app-server.test.ts · rejects steering when the thread has no active turn；test/session-message-lifecycle.test.ts · dingtalk: the default busy-message policy is steer, with no ask card or new turn；test/session-message-lifecycle.test.ts · weixin: the default busy-message policy is steer, with no ask card or new turn；test/session-message-lifecycle.test.ts · feishu: the default busy-message policy is steer, with no ask card or new turn。

### CTRL-01.2 · 输入和控制编排：超时不重发、不称已接收

已验证边界：未知写不重复派发/不切卡，具体transport timeout消息文字另需组合。

已映射测试：test/session-control.test.ts · a known preflight failure releases the native control claim; a missing write acknowledgement does not；test/session-control.test.ts · serializes controls across actors and deduplicates accepted and uncertain requests after restart；test/presentation-input-lifecycle.test.ts · uncertain steer does not produce a boundary or close the existing card。

### CTRL-01.3 · 输入和控制编排：等待期间换绑/降权后不再写入

已验证边界：普通消息写前来源复核，原生steer连接等待后原角色/个人准入仍需另一末次lease场景。

已映射测试：test/transparent-forwarding.test.ts · ordinary IM rechecks thread after attachment preparation；test/transparent-forwarding.test.ts · ordinary IM rechecks role after attachment preparation；test/transparent-forwarding.test.ts · ordinary IM rechecks access after attachment preparation。

### CTRL-02.1 · 输入和控制编排：两个客户端并发追加不覆盖已有项

已验证边界：真实隔离原生核心两peer覆盖queue正常链，专门并发append竞争矩阵仍需补，不能只靠both peers标题。

已映射测试：test/shared-app-server-integration.test.ts · one native core provides creation, unloaded continuation, goals, lifecycle, catalog and queue for both peers。

### CTRL-02.2 · 输入和控制编排：入队立即自动消费只执行一次

已验证边界：实际native正常自动消费+协调器FIFO单次；所有接收/消费竞态仍受那一次未明idle失败限制。

已映射测试：test/shared-app-server-integration.test.ts · one native core provides creation, unloaded continuation, goals, lifecycle, catalog and queue for both peers；test/native-queue.test.ts · shared dispatch preserves native FIFO, keeps origin, and consumes each item once。

### CTRL-03.1 · 输入和控制编排：重启待项/已消费/未知三种分开恢复

清单标记为 partial，但没有细化全部条件；需要先补明确组合，不能仅凭已有测试推定完整覆盖。

已映射测试：test/native-queue.test.ts · lost add acknowledgement recovers exact client id, never adds again；test/native-queue.test.ts · absence in queue/history is uncertain, not permission to replay；test/native-queue.test.ts · a consumed item is reconciled against older history by id, not similar text。

### CTRL-03.3 · 输入和控制编排：已送达完成项迟到onAccepted不建新卡

清单标记为 partial，但没有细化全部条件；需要先补明确组合，不能仅凭已有测试推定完整覆盖。

已映射测试：test/native-turn-lifecycle.test.ts · queue recovery preserves completed in its acceptance event instead of announcing a live start；test/native-turn-lifecycle.test.ts · queue recovery preserves failed in its acceptance event instead of announcing a live start；test/native-turn-lifecycle.test.ts · queue recovery preserves interrupted in its acceptance event instead of announcing a live start。

### CTRL-04.1 · 输入和控制编排：停止空闲线程不误停另一活动线程

已验证边界：host/thread/turn精确参数与source，空闲另一thread的真实并行stop需独立native反例。

已映射测试：test/execution-owner-routing.test.ts · ordinary active input, strict steering and stops preserve their native identity and source guard。

### CTRL-05.2 · 输入和控制编排：帮助包含实际支持new/unbind/queue/answer/ide等

已验证边界：help主表及unbind已断言，但answer/ide全部帮助分支须逐条映射，不把标题every当完整证据。

已映射测试：test/bridge-service.test.ts · lists every built-in command and reports the current Codex account balance without a project；test/session-unbinding.test.ts · unbind is discoverable, validates arguments and requires participant authorization。

### CTRL-05.3 · 输入和控制编排：可选Taskboard挂起不阻塞状态或首屏

已验证边界：首屏和status不挡的各自故障已覆盖；Taskboard挂起时IMstatus的联合场景未专测。

已映射测试：test/intent-review-web.test.ts · first-screen bootstrap renders core views before optional Taskboard responds；test/intent-review-web.test.ts · settings commit feedback does not depend on an optional Taskboard refresh；test/command-status-routing.test.ts · status bypasses stalled skill discovery and uses only bounded, isolated diagnostic reads。

### AUTH-01.1 · 准入与角色：群ID不当actor，未经准入不下载或提交

已验证边界：ACL在下载前；IDE group不等个人授权，所有IM平台个人/群身份仍需分渠道核对。

已映射测试：test/inbound-references.test.ts · Bridge checks actor ACL before reference reads/downloads and stages quoted files for the selected remote backend；test/ide-approval.test.ts · group ACL, contradictory group identities, unknown context and unregistered humans cannot approve or see project metadata。

### AUTH-01.2 · 准入与角色：viewer只读、participant不能停止/审批/授角色

已验证边界：viewer/participant控制限制与审批原群controller；授角色全部组合仍需独立场景。

已映射测试：test/session-intervention.test.ts · enforces roles on commands, scopes pending choices, rejects stale turns and pages history；test/bridge-service.test.ts · only a controller in the approval's original group can confirm it。

### AUTH-02.2 · 准入与角色：重复决定/多管理员竞争只生效一次

已验证边界：version及重复决定已验证；多个管理员真正并发异步竞争尚无独立场景。

已映射测试：test/admission.test.ts · a decision is exact to provider, account, request, version and selected actor/group scope; stale and duplicate commands fail closed。

### INT-02.3 · 提问与审批：断线重连原typed请求ID不变且不重发决定

清单标记为 partial，但没有细化全部条件；需要先补明确组合，不能仅凭已有测试推定完整覆盖。

已映射测试：test/shared-app-server-integration.test.ts · a shared-core approval survives observer restart with the exact native request id and no synthetic refusal。

### INT-03.3 · 提问与审批：MCP枚举/数值/布尔按schema回传，未知约束明确提示

清单标记为 partial，但没有细化全部条件；需要先补明确组合，不能仅凭已有测试推定完整覆盖。

已映射测试：test/elicitation.test.ts · MCP form retains types, bounds and native field names；test/elicitation.test.ts · MCP openai/form retains types, bounds and native field names；test/elicitation.test.ts · unsupported/secret field is not flattened: {"type":"string","format":"email"}；test/elicitation.test.ts · unsupported/secret field is not flattened: {"type":"object"}；test/elicitation.test.ts · unsupported/secret field is not flattened: {"type":"string","pattern":"x"}；test/elicitation.test.ts · unsupported/secret field is not flattened: {"type":"string","title":"Password"}；test/elicitation.test.ts · unsupported/secret field is not flattened: {"type":"string","description":"Enter verification code"}；test/elicitation.test.ts · schema constraints are enforced before submitting native JSON；test/elicitation.test.ts · thread-scoped forms need an explicit observer scope, never a guessed active turn；test/elicitation.test.ts · only non-credential HTTPS navigation URLs enter an IM notice；test/elicitation.test.ts · approval adapter cannot grant a decision absent from the native allowed set；test/mcp-confirmation.test.ts · empty MCP confirmation has an explicit once-only approval result, not persistent permission；test/mcp-confirmation.test.ts · MCP input forms, security challenges and unsupported schema constraints never become approve buttons。

### INT-04.2 · 提问与审批：IM/Web竞争一方成功另一方失效

已验证边界：实际本地HTTP/IM同approvalId version，重复决定失效；问题答案同竞态仍需另例。

已映射测试：test/approval-http.test.ts · protected Web API and IM consume the same scoped approval exactly once。

### INT-04.3 · 提问与审批：投递确认通知失败只重试原通知，不重交答案

已验证边界：已覆盖问题答案的原卡可重试/文字unknown不重发；完整审批决定通知的相同闭环待映射。

已映射测试：test/user-input.test.ts · native acceptance survives acknowledgement-card failure and retries only the same question card；test/user-input.test.ts · restart restores an unsent confirmation-card update without replaying the native answer；test/user-input.test.ts · failed plain acknowledgement is recorded as uncertain, not resent after restart。

### INT-05.3 · 提问与审批：断连保留未知决定，不自动跳过/重发

已验证边界：typed sync/async问题答案unknown保留不重放已覆盖；审批决定同边界仍须实际native路线补核。

已映射测试：test/user-input.test.ts · restart preserves durable sync answers without waiting for a native receipt or replaying uncertainty；test/user-input.test.ts · restart preserves durable async answers without waiting for a native receipt or replaying uncertainty；test/user-input.test.ts · native evidence repairs an uncertain answer after restart without replay and confirmation never regresses。

### REC-01.2 · 恢复协调：archive后断连/重启须恢复active且保留历史和项目

已验证边界：已验证write-ahead/未知archive回执/补偿中断、重启无原绑定仍恢复active。项目归属字段迁移和真实中途进程崩溃尚无独立断言。

已映射测试：test/system-error-lifecycle.test.ts · lost archive acknowledgement still compensates an observed archive without sending a task；test/system-error-lifecycle.test.ts · unarchive failure keeps the obligation; retry only restores and never archives twice；test/system-error-lifecycle.test.ts · write-ahead lifecycle facts survive restart and compensate without a remaining IM binding；test/system-error-lifecycle.test.ts · coordinator makes rollback obligation durable before any native archive。

### REC-02.2 · 恢复协调：队列/人工输入优先，恢复前最后校验

已验证边界：现有JSONL queue优先和coordinator新输入/解绑取消覆盖；最后原生写前执行代次、角色及并发新queue仍需逐分支反例。

已映射测试：test/capacity-recovery.test.ts · App Server continuation sends only empty input with inherited settings: queue=true, systemError=false；test/capacity-recovery.test.ts · user-input cancels a pending continuation before submission；test/capacity-recovery.test.ts · unbind cancels a pending continuation before submission。

### DEL-01.1 · 进展和结果交付：HTTP200空对象/业务错误不是成功

已验证边界：钉钉create/deliver/update/sessionWebhook业务回执精确；其余渠道另需映射。

已映射测试：test/dingtalk.test.ts · DingTalk rejects HTTP 200 card responses whose business result failed；test/dingtalk.test.ts · DingTalk requires operation-specific receipts, not just HTTP 200；test/dingtalk.test.ts · DingTalk session webhook requires errcode zero before creating a local receipt。

### DEL-01.2 · 进展和结果交付：投递失败不改Codex终态

已验证边界：结果投递失败保原终态payload，不发替代答案；native executor终态在更下层fixture。

已映射测试：test/bridge-service.test.ts · reports terminal card delivery failure once without sending a replacement answer；test/channel-progress.test.ts · terminal card delivery failures produce one error notice, never a replacement answer, even after restart。

### DEL-02.2 · 进展和结果交付：投递部分成功不当全部拒绝重试

已验证边界：phase/subresult事实分开，原实例恢复；真实多人目标部分成功需供应商响应实际验收。

已映射测试：test/stream-bootstrap.test.ts · delivery sub-results with explicit false are rejections, not ambiguous business acknowledgements；test/stream-bootstrap.test.ts · created-but-rejected delivery persists each phase and force sync resumes only the original instance。

### DEL-03.1 · 进展和结果交付：DNS/白名单暂错恢复原卡不刷屏

已验证边界：真实stream调度+fake传输/时间，保原卡/有界probe，非真实DNS/白名单恢复。

已映射测试：test/channel-progress.test.ts · recovers the original card with the newest state without sending text progress；test/channel-progress.test.ts · route-dependent rejection recovers only the original card without text degradation；test/channel-progress.test.ts · route rejection probes are bounded at 30, 60 and 120 seconds, without opening replacements。

### DEL-04.2 · 进展和结果交付：重启/force sync不批量发送未知历史

已验证边界：无界历史不能由未知ID冒充新任务；该测试只用有限历史fixture，force-sync/1000轮另需场景。

已映射测试：test/thread-event-hub.test.ts · background and forced follow retain five unsent historical results without creating a notification burst。

### DEL-05.3 · 进展和结果交付：分段和重启不丢参与者/原turn身份

已验证边界：原turn名单/accepted来源跨重启保留；旋转同时多群/崩溃矩阵未穷尽。

已映射测试：test/turn-audience.test.ts · audience preserves first participation order, actor deduplication and exact destination across restart；test/turn-audience.test.ts · accepted steer provenance survives restart; an uncertain native submission never becomes a participant。

### DEL-06.3 · 进展和结果交付：创建名单/卡内标签/投递名单均保留，失败不丢旧正文

已验证边界：真实adapter+SDK/HTTPS传输替身，@metadata与正文保全，失败不清旧正文；实际钉钉标签和通知可见性另验。

已映射测试：test/dingtalk.test.ts · DingTalk https merges full result and native @, then summarizes only the original segment；test/dingtalk.test.ts · DingTalk sdk merges full result and native @, then summarizes only the original segment；test/dingtalk.test.ts · DingTalk merged result create failure never causes a second delivery or prematurely removes the original answer；test/dingtalk.test.ts · DingTalk merged result deliver failure never causes a second delivery or prematurely removes the original answer；test/dingtalk.test.ts · DingTalk merged result final failure never causes a second delivery or prematurely removes the original answer；test/dingtalk.test.ts · DingTalk merged result summary failure never causes a second delivery or prematurely removes the original answer。

### DEL-08.1 · 进展和结果交付：等待审批/提问、恢复执行、完成的正文与圆环同步

已验证边界：生产adapter传输payload状态/圆环参数，实际客户端渲染仍需验收。

已映射测试：test/dingtalk.test.ts · DingTalk https keeps native loading last, hides it while waiting, and resumes the same card；test/dingtalk.test.ts · DingTalk sdk keeps native loading last, hides it while waiting, and resumes the same card。

### DEL-08.2 · 进展和结果交付：累计进度、重复压缩、多次compaction不重复或停旧状态

已验证边界：包含真实多次compaction phase进入同卡，不仅去重单一文本；真实客户端圆环/排版未验。

已映射测试：test/channel-progress.test.ts · cumulative compaction progress is atomic, deduplicated and ends at the latest phase；test/bridge-service.test.ts · streams progress and answer deltas into one channel AI Card and finalizes the parsed answer。

### DEL-09.4 · 进展和结果交付：Desktop专用code-comment等展示指令投影为可读结果，不裸露属性串/重复正文；围栏、引用与行内代码中的字面示例保持。覆盖进度、最终、原生@、纯文本及历史，不执行展示指令。历史图片记录2717为实际故障依据，仍需逐路径映射。

清单标记为 partial，但没有细化全部条件；需要先补明确组合，不能仅凭已有测试推定完整覆盖。

已映射测试：test/full-review-presentation.test.ts · Markdown projection keeps protected original bytes for "\r\n" input；test/full-review-presentation.test.ts · Markdown projection keeps protected original bytes for "\r" input；test/full-review-presentation.test.ts · plain DingTalk transport unwraps CRLF fenced exact replies without exposing code wrappers。

### DEL-10.2 · 进展和结果交付：复制不提交/执行/批准/选择且失败可手动复制

已验证边界：copy panel只复制、不决定，原生表单直接提交；所有IM复制按钮原生行为不是本机DOM证据。

已映射测试：test/ide-approval.test.ts · copy panels expire on owner, provider, request, port or clock changes and never execute a decision；test/ide-web.test.ts · local multi-root approval shows reference directories without copy controls and submits the exact displayed scope。

### DEL-10.3 · 进展和结果交付：目录树/内部enum/参考路径不自动加复制框

已验证边界：管理UI roots普通展示不复制；模型输出的任意目录树/enum不能仅靠这个表单测试外推。

已映射测试：test/ide-web.test.ts · local multi-root approval shows reference directories without copy controls and submits the exact displayed scope。

### CHAN-01.2 · IM适配和网络：企业微信群身份不借群ID提升角色

已验证边界：actor与群target分离、清listener；完整role升级组合未在adapter内证明。

已映射测试：test/channel-adapters.test.ts · WeCom group actor identity stays separate from the reply target and monitor listeners are removed。

### CHAN-01.3 · IM适配和网络：连接/reconnecting/停止反映真实阶段、回调异常到统一错误处理

已验证边界：真实readiness/cleanup边界，所有provider重连状态全排列仍须实际平台验收。

已映射测试：test/channel-adapters.test.ts · account startup waits for channel readiness and exposes capabilities without credentials；test/channel-adapters.test.ts · Feishu unsupported input is normalized rather than silently ignored, and SDK start failures close the socket；test/dingtalk.test.ts · DingTalk removes its listener and disconnects when the Stream connection fails。

### CHAN-04.1 · IM适配和网络：某条未处理崩溃后不被游标跳过

已验证边界：真实monitor替身API验证批次失败范围游标，不是真实进程在任意指令间骤停。

已映射测试：test/weixin-monitor.test.ts · continues with the remaining batch after one message fails；test/weixin-monitor.test.ts · skips duplicate message ids and persists the latest sync key。

### CHAN-04.3 · IM适配和网络：停止/迟到登录/过期二维码不启动新账号

已验证边界：过期二维码等待响应后不能确认；其他停止/迟到账号启动路径未同组覆盖。

已映射测试：test/full-review-network.test.ts · Weixin QR polling cannot confirm a login that expired during the request。

### IDE-02.1 · IDE运行与浏览器访问：两个仓库同窗独立Git且终端默认session目录

已验证边界：实际完整roots/私有workspace/默认cwd，假code-server；两个真实Git UI及终端打开行为未实测。

已映射测试：test/ide.test.ts · same project entry opens both roots only after explicit expanded approval and persists exact trust；test/ide.test.ts · managed project metadata exposes all same-host IDE roots without changing session cwd or binding；test/ide.test.ts · real host helper generates a private multi-root workspace without writing config into repositories。

### IDE-02.3 · IDE运行与浏览器访问：根次序/显示改名不失权，实际目录/host变更须重新核验

已验证边界：别名移除/完整scope及approval中变化，根次序所有组合未单独验证。

已映射测试：test/ide-membership.test.ts · a project/worktree entry survives alias removal and restart without retargeting or widening authorization；test/ide.test.ts · multi-root canonical checks reject retargeting, missing members and project mutations during approval。

### IDE-03.3 · IDE运行与浏览器访问：IDE故障不改绑定/提交输入/停止Codex

已验证边界：可选IDE构造/ingress失败隔离，不借输入；所有运行异常/绑定不变仍需组合。

已映射测试：test/ide.test.ts · corrupt optional IDE files fail closed without breaking unrelated Gateway construction；test/ide-endpoints.test.ts · an unavailable remote ingress does not block loopback maintenance or shutdown; no link fallback。

### IDE-06.1 · IDE运行与浏览器访问：跨站点入有效grant无3秒等待授权闪烁

已验证边界：真实本地HTTP静默同源页和后续进入，未跑外部手机跨站及实际加载时延。

已映射测试：test/ide.test.ts · external first hop silently rechecks Strict cookies without approval UI, grants or IDE startup；test/ide.test.ts · authorized browser enters the usable IDE directly while degraded-profile warnings stay in management status。

### IDE-06.2 · IDE运行与浏览器访问：同源再次打开复用实例且无新申请

已验证边界：manager复用独立验证，完整浏览器重复打开不新增申请的联合路径仍需实机。

已映射测试：test/ide.test.ts · canonical host/owner/profile instance reuse, concurrent opens and fresh target validation。

### IDE-06.3 · IDE运行与浏览器访问：撤销/过期时真正回授权页，不能降低Cookie策略

已验证边界：本地HTTP/WS拒绝旧凭据及跨域、Cookie仍Strict；真实手机回授权页未验。

已映射测试：test/ide.test.ts · local browser authentication guards HTTP/WS, strips credentials, denies foreign origins and revokes sockets；test/ide.test.ts · personal browser authentication guards HTTP/WS, strips credentials, denies foreign origins and revokes sockets。

### IDE-08.1 · IDE运行与浏览器访问：Linux/mac双架构选对，失败不破坏旧版

已验证边界：平台/制品选择、激活前撤销保旧版；下载fixture，真实平台安装/hash独立核验仍不足。

已映射测试：test/ide-installer.test.ts · macOS x64 selects the pinned native package without a Linux libc requirement；test/ide-installer.test.ts · macOS arm64 selects the pinned native package without a Linux libc requirement；test/ide-installer.test.ts · revocation before activation leaves the current executable untouched；test/ide-installer.test.ts · unsupported platform, old libc, revoked permission and custom binaries fail without system changes。

### IDE-08.3 · IDE运行与浏览器访问：Dark2026/Seti/Menlo12/行高18/Chat默认收起/Emacs实际键位

已验证边界：实际JSONC和扩展helper验证配置/缺失才安装；code-server实际主题/键位视觉操作未验。

已映射测试：test/ide-profile.test.ts · Chat defaults are additive, JSONC-safe and never clobber explicit preferences；test/ide-profile.test.ts · appearance defaults match the desktop appearance and preserve explicit editor overrides；test/ide-profile.test.ts · first open verifies Emacs, installs only missing, isolates trust profiles, and deduplicates opens。

### IDE-09.3 · IDE运行与浏览器访问：SSH断线残socket安全判定后重连，原授权同origin不变

已验证边界：实际本机Unix socket模拟SSH lifecycle，owned inode安全清理；非真实SSH断线环境。

已映射测试：test/ide-endpoints.test.ts · remote reverse socket recovery prunes only owned stale socket inodes, never active listeners, files or symlinks；test/ide-endpoints.test.ts · host entrances isolate scopes, keep native auth, and reconnect without changing grants, project instances or stable links。

### WEB-01.1 · 管理UI：旧保存不关闭新窗口，不覆盖新任务详情

已验证边界：实际Web脚本VM+DOM替身逐handler归属，Taskboard iframe内部App异步写仍另列TB-09未解决。

已映射测试：test/intent-review-web.test.ts · an old session save cannot close the reopened edit dialog；test/intent-review-web.test.ts · an old project save cannot close the reopened edit dialog；test/intent-review-web.test.ts · a retired knowledge save cannot close or overwrite a newer dialog: success；test/intent-review-web.test.ts · a retired knowledge save cannot close or overwrite a newer dialog: failure；test/full-review-web-races.test.ts · a late Taskboard detail cannot populate a different selected issue。

### WEB-01.2 · 管理UI：刷新不替换聚焦/脏表单或二维码

已验证边界：知识绑定焦点/保存及QR代次保护；全部脏表单组合不由三个例子外推。

已映射测试：test/full-review-web-races.test.ts · automatic knowledge refresh preserves a focused or saving binding control；test/full-review-web-races.test.ts · a retired QR creation response cannot replace or poll the current login；test/full-review-web-races.test.ts · a retired QR poll cannot expire the newly opened login。

### TB-01.2 · Taskboard子包：状态表单原生保存不需复制enum

已验证边界：真实Bridge表单handler，原生payload不需用户复制enum；手机/各平台原生控件另验。

已映射测试：test/taskboard-channel-workbench.test.ts · uses native forms for task creation and executes their canonical submit command；test/taskboard-channel-workbench.test.ts · executes the native workflow and deduplicates repeated form submissions。

### TB-01.3 · Taskboard子包：可选服务关闭/失败正确展示并清理，现有任务不误删

已验证边界：真实独立临时服务启停，不删既有数据；Web切开关失败全部联动仍需核对。

已映射测试：test/embedded-taskboard.test.ts · starts and closes the embedded Taskboard with isolated data；test/embedded-taskboard.test.ts · reuses a healthy Taskboard already listening on the managed port。

### KB-01.1 · 知识与QA：远程项目不读本地同路径知识

已验证边界：远程项目不能作为本地目录QA默认值；已绑定QA所有动态tool读取同host仍需执行路径证明。

已映射测试：test/intent-review-config.test.ts · remote projects cannot become local directory-backed QA defaults。

### KB-01.3 · 知识与QA：旧列表删除按稳定ID、保存迟到不改新窗口

已验证边界：迟到保存归属由实际VMhandler验证；列表删除的稳定ID/重排场景尚缺。

已映射测试：test/intent-review-web.test.ts · a retired knowledge save cannot close or overwrite a newer dialog: success；test/intent-review-web.test.ts · a retired knowledge save cannot close or overwrite a newer dialog: failure。

### REL-01.1 · 构建和重启：接收前拒绝与接收落盘后放行分界准确

已验证边界：真实Web/Bridge业务计数分界，native通过fixture接收；accept落盘失败的整个release组合还需联动。

已映射测试：test/restart-ownership.test.ts · the real Web submission becomes restartable only after native acceptance; release detaches observation without cancellation；test/bridge-handoff-admission.test.ts · Bridge rejects a competing start promptly while the original input is in handoff；test/bridge-handoff-admission.test.ts · Bridge rejects a competing start promptly while the original input is accepted。

### REL-01.2 · 构建和重启：Gateway退出不stop原生服务，重连同turn输入一次

清单标记为 partial，但没有细化全部条件；需要先补明确组合，不能仅凭已有测试推定完整覆盖。

已映射测试：test/shared-app-server-integration.test.ts · Gateway disconnect after acceptance does not interrupt a peer-visible native turn or repeat its input。

### REL-01.3 · 构建和重启：旧未确认问答记录/只读轮询/退避计划不无限拦重启

已验证边界：已修复问答等待不锁重启；recovery只读checking/pending大范围仍是已记录候选，不宣称全部放行正确。

已映射测试：test/restart-handoff-boundaries.test.ts · sync questions protect sends, not human waiting, partial answers or durable native uncertainty；test/restart-handoff-boundaries.test.ts · async questions protect sends, not human waiting, partial answers or durable native uncertainty。

### REL-02.2 · 构建和重启：发布并发互斥、失败回退不扩大任务中断

已验证边界：真实临时lock竞态和错误cleanup；全发布崩溃/各平台回滚尚不完整。

已映射测试：test/intent-review-release.test.ts · release cutovers claim exclusive ownership before an asynchronous readiness read；test/intent-review-release.test.ts · release ownership closes its descriptor and does not erase an unverifiable lock if fstat fails。

### TB-02.3 · Taskboard子包：FileReader异步准备期间换项目或新建会话，迟到附件不能追加到新草稿；原来草稿的文件与失败反馈有正确归属。来自实际代码职责推演，需真实组件反例。

已验证边界：已验证原草稿正常与读取期间新建对话；换项目、切历史会话及迟到错误尚须独立场景。

已映射测试：taskboard/test/ai-chat-browser.test.mjs · late file reads belong only to the original composer while unchanged drafts still receive their attachment。

### TB-02.4 · Taskboard子包：原生start或创建线程失败时保留原草稿及附件，不用重新创建任务掩盖未知接收；开始提交后新编辑不能被旧回执清空。来自实际代码职责推演，需正常/明确未接收/未知对照。

已验证边界：真实Chrome已验证HTTP400明确拒绝创建/turn后文字、Skill、附件保留，显式重试正常；pending POST重复Enter只发一次；旧接收回执不清改动草稿，旧create/turn不抢回已切换的会话。未知接收后的重试/幂等归属尚未验证，不能宣称完整原生协议统一。

已映射测试：taskboard/test/ai-chat-browser.test.mjs · known create and turn rejections preserve the submitted text, skill and attachment for an explicit retry；taskboard/test/ai-chat-browser.test.mjs · pending turn submission sends once and an accepted late receipt preserves a changed draft；taskboard/test/ai-chat-browser.test.mjs · late thread creation and turn receipts keep a newly selected conversation and its draft。

### TB-09.3 · Taskboard子包：评论提交中用户编辑新草稿，旧成功不能清空新内容；TaskDetail已用task.id key，父级回调仍需反例。

已验证边界：真实Chrome同任务提交等待中编辑不被清空；正常原草稿被清理、原评论body只发一次。父App切项目回调、部分上传、未知接收仍未覆盖。

已映射测试：taskboard/test/ai-chat-browser.test.mjs · a confirmed comment clears only its unchanged draft and preserves edits made while its request was pending。

