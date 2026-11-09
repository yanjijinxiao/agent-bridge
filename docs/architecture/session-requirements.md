# 本 session 的需求与决定索引

2026-11-09 对三段可恢复历史重新提炼。按时间顺序核对了 894 条用户记录，并针对接受方案、取消范围、术语解释回读相邻公开答复。这里的 U0001～U0894 是本次用户记录序号，与旧审计的 `sourceRecords` 不是同一编号。来源范围和阅读限制见[本次审计](../audits/2026-11-09-session-documentation/README.md)。不在仓库复制聊天原文、员工 ID、群标识、私有链接或设备凭据。

本索引回答“用户要求过什么、后来如何改变、现在由谁负责”。它不替代功能合同、代码或测试，也不把有映射的要求标为完整验收。仅截图而无足够文字的报告沿用已有图片检查和缺失记录，不从文件名猜故障。

## 文档与证据的唯一入口

| 内容 | 权威记录 | 使用方式 |
| --- | --- | --- |
| Gateway 共用功能及 Codex 行为 | [需求与 case](gateway-requirements.json)、[人读功能合同](gateway-contracts.md) | 96 项要求、459 个 case；逐 case 的状态、测试名和边界优先于汇总段落 |
| Herdr TUI / App 适配 | [Herdr 功能与测试](../audits/2026-11-07-herdr-adapters/production-requirements.json)、[实现及实测清单](../audits/2026-11-07-herdr-adapters/production-checklist.md) | 20 项 HDR 合同，沿用其精确测试名和环境边界；与前一份清单的粒度不同，不相加成“116 项全部验收” |
| 模块、函数和调用关系 | [实现职责图](gateway-implementation-map.md)、各模块说明、[精选函数合同](function-contracts.jsonl) | 函数记录只证明所列版本/范围；不能批量换 hash 冒充重读 |
| 待办与取消范围 | [剩余清单](remaining-work.md)、本文决定表 | 部分覆盖、已确认缺陷、未开发、用户取消分别表示 |
| 用户操作方法 | [探探 Codex 教程](../tantan-connector-guide.md)、[Herdr 教程](../herdr-connector-guide.md)、[README](../../README.md) | 教程解释使用步骤和真实功能，不承担长篇发布日志或内部审计 |

## 执行入口与后端职责

| 历史来源 | 现行要求与边界 | 功能／模块 |
| --- | --- | --- |
| U0069、U0082、U0246–U0259、U0683–U0685 | Codex 桌面与 CLI 复用一套完整 App Server 适配。连接方式不同不产生第二套审批、队列和执行逻辑；断连不启动另一执行器、不抢线程写锁 | NATIVE-01、NATIVE-02；[原生连接](modules/native-protocol.md) |
| U0667–U0679 | 续聊继承原生 sandbox、reviewer 和权限，不能因没有回调而改成只读＋人工审批；审批连接故障不能靠反复索取同一授权解决 | NATIVE-02.2、INT-02；[原生交互](modules/native-interactions.md) |
| U0022–U0023、U0618 | 长任务无输出不代表终止；读取超时、观察断连、系统失败、执行终态分别处理 | NATIVE-05、NATIVE-06、REC-01；[恢复](modules/recovery-coordinators.md) |
| U0785–U0787、U0793–U0798 | Gateway 本机及远程执行全部经 Connector。Connector 承担连接/传输，原有目录、审批、附件、IDE 等端口不能迁移后丢失。无设备时明确不可用，不回退本机执行 | NAT-07、PEER-01；[Connector 唯一入口](connector-only-execution.md) |
| U0788–U0794 | 连接身份与目标主机身份分开；一个 Connector 可访问多个已登记原生主机。停止某个 Linux 测试 Connector 是当时的运维动作，不等于取消 Linux 支持 | NAT-07.10；[多主机路由](connector-host-routing.md) |
| U0851–U0861、U0870 | 按能力和操作语义抽象接口，未来 agent 作为设计参考；当前实现范围是 Codex 和 Herdr TUI/App，不由调研名单自动扩大开发范围 | HDR-11、HDR-16；[运行接口设计](herdr-adaptation-design.md) |
| U0866–U0870、U0877 | Herdr App 与 TUI 分别适配各自真实接口，core 作为 App 依赖，不另设第三种用户后端；Mac App、Linux TUI 的安装与真实执行各验各的 | HDR-01、HDR-02、HDR-07、HDR-13；[运行接口模块](modules/agent-runtime.md) |

## 输入、设置、控制与恢复

| 历史来源 | 现行要求与边界 | 功能／模块 |
| --- | --- | --- |
| U0265–U0271、U0589、U0595 | 普通忙时消息默认 steer；显式 queue 使用 Codex 原生持久队列。Gateway 仅保留来源、回执和投递义务，不维护另一份会自动重发的 prompt 队列 | CTRL-01、CTRL-02、CTRL-03；[输入控制](modules/input-controls.md) |
| U0734（使用解释） | 已有 `/prompt` 消息合并区用于明确收集后提交，与原生 queue 分开；收集内容可持久恢复，尝试提交后的未知回执不因再次 done 自动重发 | IN-02.5、STATE-01.4；[输入控制](modules/input-controls.md) |
| U0289–U0300、U0629–U0645、U0688 | 明确未提交、已接收、回执未知分开。未知输入不自动重发；前序未知不无限阻塞可独立处理的状态查询；重启不停止已接收任务 | IN-02、IN-03、REL-01；[消息交接](modules/inbound-forwarding.md) |
| U0698、U0714、U0723–U0728 | 崩溃恢复要验证真实进程骤停，不以对象重建替代；恢复原线程、原输入和原卡，校验执行/投递次数 | IN-02.2、CTRL-03、TB-09.6、HDR-04、HDR-05；[审查方法](modules/audit-method.md) |
| U0807–U0810 | `/model`、effort、Plan 等是一次原生设置操作。Gateway 不保存覆盖值在续聊/重启时写回，桌面后改值应保留；与目录选择、绑定和安全回执的必要持久化区分 | CTRL-06；[持久状态](modules/persistent-state.md) |
| U0885–U0888 | 未注册 `/xxx` 先给文字提示，再原文转发；路径、正文和引用不误判。已注册命令的参数/能力/权限错误不变成普通输入 | IN-01.slash-forwarding、CTRL-05.runtime-help；[斜杠路由](slash-routing-and-runtime-help.md) |
| U0602–U0611、U0859–U0861、U0885–U0886 | `/help` 按实际后端和子操作说明，包含别名、扩展和新命令；无某项原生能力不禁用无关 Gateway 功能。状态/目录查询不被重型历史或控制等待堵住 | CTRL-05、NATIVE-04、HDR-11；[运行接口模块](modules/agent-runtime.md) |

## 项目、会话、绑定与权限

| 历史来源 | 现行要求与边界 | 功能／模块 |
| --- | --- | --- |
| U0002、U0014–U0020、U0064–U0088、U0113–U0129 | 目录与真实后端一致；普通会话、无项目会话、归档状态、原生标题和 ID 不得被模型指令前缀或自建影子目录替代 | CAT-01、CAT-03、CAT-04、NATIVE-02.6；[目录历史](modules/catalog-history.md) |
| U0588、U0703、U0794–U0796 | `/sessions` 保留置顶、项目＋session、中间空项目和其他会话；稳定编号/分页、较充分的单页内容，不以截断或丢项目降低输出量 | CAT-02、NAT-07.5；[目录历史](modules/catalog-history.md) |
| U0823–U0824、U0828–U0836 | CLI `resume` 能看到而目录缺失、桌面只显示远端不显示本地、查询失败均应按当前 host/home/来源范围排查；远端失败不换成本机结果 | CAT-01、NATIVE-03、NAT-07.9、NAT-07.10；[Connector 端口表](modules/peer-interface-matrix.md) |
| U0113–U0123、U0351、U0482–U0485 | `/new`、无项目新建、显式项目与所有 rootPaths 完整关联；不能只依据 cwd。解绑是精确聊天边，未绑定要明确；解绑不停止后端任务 | CAT-03、BIND-01、IDE-02；[绑定准入](modules/bindings-access.md) |
| U0316、U0351、U0546–U0551 | 多绑定的主交互入口、审批来源和回复目标要明确；Web 总览支持核对关系，换绑/解绑后旧异步回复不得回到新目标 | BIND-02、BIND-03、BIND-04、BIND-05；[绑定准入](modules/bindings-access.md) |
| U0735–U0742 | `/connect`、`/access` 默认只显示当前机器人、当前聊天、当前用户有权看的范围。跨聊天管理需明确管理员私聊入口，隐藏展示不等于新增授权 | AUTH-01、AUTH-02、PEER-02；[权限展示](modules/bindings-access.md) |
| U0736–U0741、U0771–U0772 | 首次 Connector 自助登记/配对关联已核验用户。设备凭据本机生成、保存，不要求群里分发 device.token；移除手工领凭据不等于删除设备认证 | PEER-01.4、PEER-02；[设备传输](modules/peer-transport.md) |
| U0756、U0762 | 谁提供 session 谁批准共享；同群另一人不能借公共聊天任意解绑或接管别人的 session。个人准入、会话角色、设备授权与资源共享分别检查 | PEER-02、BIND-02、AUTH-01；[绑定准入](modules/bindings-access.md) |
| U0779–U0784 | `/connect use` 的目录选择按用户/聊天/账号持久化，影响 `/sessions`、项目和新建；临时 host 查询不改默认。换目录设备与换执行绑定是两项操作 | CAT-05；[Connector 选择](modules/connector-selection.md) |
| U0767、U0819 | 探探从 SQL Engine 扩大为 MaxCompute 及下属部门个人准入；是部署名单快照，不是产品硬编码部门、自动通讯录同步或管理员授权 | [部署准入记录](../audits/2026-11-06-maxcompute-admission/README.md)、[绑定准入](modules/bindings-access.md) |

## 交互、卡片与附件

| 历史来源 | 现行要求与边界 | 功能／模块 |
| --- | --- | --- |
| U0242–U0245、U0313–U0344、U0568–U0572、U0664–U0675 | 审批、工具提问、浏览器问题、自由回答和多选走真实请求；保留一次/会话/持续等原选项，不编造所有后端共有的选项。答案提交不等于原生批准，内部自动审核不伪造成可点审批 | INT-01、INT-02、INT-03、INT-04；[原生交互](modules/native-interactions.md) |
| U0345–U0346、U0702 | 审批或 steer 确认成功后以新 AI 卡继续同一任务；旧卡保留阶段总结。排队成功时不冒充任务开始，等实际执行再开卡；审批消息 @ 原参与者 | INT-04.4、INT-01.8、DEL-05；[交互模块](modules/native-interactions.md) |
| U0110、U0227–U0239、U0274–U0283、U0625–U0627、U0804、U0811–U0818 | 不刷重复卡，不把发送/创建/更新回执混为一体；拒绝或未知投递不自动另发文本；终态清理停止控件和加载状态，发送失败仍保留真实任务结果 | DEL-01、DEL-02、DEL-03、DEL-07、DEL-09；[结果渠道](modules/delivery-channels.md) |
| U0491–U0507、U0566、U0805、U0821 | 首屏有简洁普通字号状态及原生加载反馈，保留图标/缩进；加载位于内容区域，不能被复制框或 IDE footer 顶到底部或反复重复 | DEL-08、DEL-09；[阶段进展](phase-progress.md) |
| U0803、U0881 | 阶段成果持续可见，工具/命令实时信息只保留有界窗口；阶段结束留总结，超长续卡。Codex 和 Herdr 进行中/最终结果均保留结构，不直接倾倒 ANSI 终端字符 | DEL-08.8、DEL-08.9、DEL-08.10、DEL-08.11、HDR-18；[终端展示](modules/terminal-presentation.md) |
| U0364、U0368、U0509、U0563、U0696、U0704 | 最终 @ 本轮相关参与者，含补充输入者；进行中、续卡和最终结果都保留当前项目固定 IDE 入口。页脚由 Gateway 统一生成，模型不再拼一份 | DEL-06、DEL-08.4、IDE-01、IDE-09.4；[结果渠道](modules/delivery-channels.md) |
| U0476、U0486、U0489–U0490、U0522–U0545、U0630 | 只有完整必要回复/命令/跨页面转移值提供独立复制框；目录树、说明、已有 ID、原生表单选项不用复制。复制不提交、不授权、不执行；模板标注需修改 | DEL-10；[结果渠道](modules/delivery-channels.md) |
| U0026–U0037、U0133–U0149、U0278–U0283、U0723、U0801 | 图片/文件/视频及引用保留原来源和完整内容；引用无下载凭据须明确缺失，不能假装读过；纯文字不夹带旧图，不因转发迁移丢附件 | IN-05、IN-06、CHAN-03、NAT-07.11；[消息交接](modules/inbound-forwarding.md) |
| U0775–U0778 | 删除 Gateway 自建长期记忆的注入/菜单/动作；原生 agent 记忆不变。旧混合动作仍正确处理附件，去掉记忆动作不能把附件序号和恢复回执错位 | KB-02；[持久状态](modules/persistent-state.md) |
| U0001、U0025–U0041、U0101、U0123 | 多 IM 复用业务语义，渠道按真实能力编码；某台机器暂时只跑钉钉不是删除微信/飞书/企微支持。SDK 成功与用户实际看到分别报告 | CHAN-01、CHAN-02、CHAN-03、CHAN-04；[结果渠道](modules/delivery-channels.md) |

## Web IDE、浏览器与配置

| 历史来源 | 现行要求与边界 | 功能／模块 |
| --- | --- | --- |
| U0374–U0398、U0445–U0448、U0470–U0473 | 每项目一个稳定 HTTPS 入口，手机电脑共用；本机/远端内部路由不同，外部不暴露 127.0.0.1。项目全部根目录、Git 和终端可用，code-server 独立运行 | IDE-01、IDE-02、IDE-03、IDE-09；[IDE 访问](modules/ide-access.md) |
| U0401–U0438、U0555–U0562、U0889–U0892 | 用实际网卡/固定内网入口，不使用易变 VPN 地址；区分证书信任、网络到达、入口脚本兼容、后端失联。远端 HTTPS/WS 需实际核对，不能用本机连通代替 | IDE-09、IDE-14.webview-timeout、IDE-03.health-retry；[IDE 访问](modules/ide-access.md) |
| U0389–U0390、U0517–U0521 | 无第二套 IDE 密码，复用 Gateway 个人准入；浏览器授权 90 天并持久化。群准入不是个人浏览器授权，管理页面访问权不自动授予 IM 用户 | IDE-04、IDE-05、IDE-06、IDE-07；[绑定准入](modules/bindings-access.md) |
| U0476、U0750、U0752–U0754 | 用户明确接受探探持链接进入：新浏览器同源交换后进入精确项目，不再强加钉钉免登；保留到期、撤销、项目停用和资源范围。此模式不冒充钉钉个人或管理权限 | IDE-13、IDE-14；[IDE 访问](modules/ide-access.md) |
| U0396–U0398、U0750 | 已授权项目默认信任精确目录；信任不是扩大到所有目录或所有人的 Connector。只在原授权范围内免重复确认 | IDE-13；[IDE 访问](modules/ide-access.md) |
| U0418、U0422–U0424、U0769–U0772、U0818 | 默认收起 Chat；VS Code 迁移指主题、图标、字体、字号、行高和键位等实际效果。采用原生 settings/扩展配置与管理，不固定网页 checkbox 扩展清单；支持与实际安装分开核验 | IDE-08；[IDE 访问](modules/ide-access.md) |
| U0745–U0748、U0785–U0787 | CLI 和 Connector 都提供完整 IDE（含 Git、终端），复用 HTTP/WS 和设备文件授权；不能只给共享文本编辑器而声称完成 | IDE-11；[Connector 传输](modules/peer-transport.md) |
| U0748–U0749、U0889–U0892 | 安装/启动同页进度，成功只跳转一次，错误可手动重试而不循环；端点失效沿原授权恢复，失败写操作不重放 | IDE-12、IDE-14.webview-timeout；[IDE 访问](modules/ide-access.md) |
| U0511、U0563、U0696、U0704 | 项目已移除时取消旧入口；unknown 不当 none；绑定/归属改变后不沿用旧授权。进度缺链接是功能缺陷，不能用手写模型 footer 绕过 | IDE-01、IDE-02、BIND-02；[IDE 访问](modules/ide-access.md) |
| U0766–U0768 | 新接入不要求人工填写 CA；按连接信任方案核验服务端，不能推广成所有请求关闭 TLS 校验。证书、设备身份和用户授权是三件事 | PEER-01.4、IDE-09；[Connector 传输](modules/peer-transport.md) |

## 运维、文档和开发验收

| 历史来源 | 现行要求与边界 | 功能／模块 |
| --- | --- | --- |
| U0631–U0662、U0688、U0726 | 发布门禁只保护 Gateway 未完成交接，准备和检查先完成，再直接切换；已接收任务不锁重启。push、制品、运行版本分别核对；要求双环境上线时核对头头/探探及受影响 Connector | REL-01、REL-02；[发布生命周期](modules/release-lifecycle.md) |
| U0837–U0848 | 产品改名 Agent Bridge、使用用户 npm scope；GitHub/README/教程同步。产品包版本单源，接口/日志结构有自己的兼容版本；不混用发布号、协议号与状态迁移号 | VER-01、VER-02；[版本制度](version-contracts.md) |
| U0090–U0100 | 独立项目仍保留上游 MIT 版权和署名；公开仓库/安装包不含个人配置、凭据和业务私密材料 | STATE-03.3；[NOTICE](../../NOTICE)、[LICENSE](../../LICENSE) |
| U0583–U0588、U0597、U0624、U0697–U0700、U0716、U0720、U0873–U0876 | 文档先行，从模块意图推到函数、逐行范围和边界 case；四层是架构、模块异常/遗漏、文件函数、静态/配置。远端更新后按新版本重新对照，不沿用旧“完成” | AUDIT-01；[审查方法](modules/audit-method.md) |
| U0743–U0747、U0877–U0882 | 正交验证后端、传输、身份/聊天、生命周期、故障、展示入口。探探真实端到端、Codex CLI/App 回归与 Herdr 两端分别核验；手机不是所有 IM/浏览器功能的必需前提 | AUDIT-01.3、HDR-16；[Herdr 矩阵](herdr-adaptation-design.md) |
| U0705–U0713、U0719、U0773、U0802、U0806、U0893–U0894 | 功能文档、模块说明、测试映射、注释、README 和教程随行为同步。原 28 项缺测有直接用例；有测试映射不等于全部真实组合通过，取消范围不继续列成必做 | AUDIT-01；[文档维护合同](modules/documentation-maintenance.md) |
| U0755、U0757、U0760–U0765、U0773、U0802–U0806、U0820、U0848、U0883–U0884 | 探探教程保留可用 Gateway 地址，解释用户要填哪些值及如何取得；不固定旧 Git 提交，不堆长更新日志。Herdr 与 Codex 结构相近；用户明确要求时发送 Markdown 并同步指定语雀文档 | [文档维护合同](modules/documentation-maintenance.md)、[两份教程入口](../tantan-connector-guide.md) |
| U0151–U0208 | 建群、添加现有机器人、客户端分组和绑定属于明确调用的建群工作流；DWS 服务端分组不冒充客户端分组。用户已授权的新群加机器人不重复询问 | 环境中的 dingtalk-session-group skill；不据此增加 Gateway 隐式自然语言命令，IN-01.1 |
| U0729–U0732 | 原“逐节点执行器”解释曾扩大范围。保留已有手动执行功能；不继续开发七类外部供应商、自动触发、云端工作流写回和流程产物归档 | TB-10.3；[节点执行](modules/workflow-node-execution.md) |

## 已取代、取消及不能当作需求的内容

| 早期方案／事件 | 现行决定 | 不得产生的回退 |
| --- | --- | --- |
| 忙时默认 ask/queue | U0271 后默认 steer，显式 queue 仍原生持久化 | 不恢复 Gateway 自建待执行输入队列 |
| 桌面私有 IPC、另一个执行器、Gateway 直连/SSH 执行 | U0685 单一 Codex 协议；U0787 后全部经 Connector；U0870 新增两套 Herdr 适配 | 不因重连或缺功能偷偷换后端，不将 Herdr 伪装成 Codex turn |
| IDE 内部回环地址、统一远端中转、动态 VPN 地址 | 每项目固定外部 HTTPS，按项目主机选择内部路由 | 不把 127.0.0.1 当手机链接，不把本机项目硬转到另一台服务器 |
| 8 小时／15 天授权、额外密码、重复确认、钉钉 OAuth | 90 天；个人确认模式保留，探探明确接受持链接模式 | 不取消实际访问检查，不把 IDE grant 升为管理员 |
| 固定网页扩展选择、手工领取 device.token/CA | 原生配置/扩展管理，设备自助登记及连接信任 | 不删除设备认证或全局禁用 TLS |
| Gateway 长期记忆、执行设置覆盖值 | U0778 删除自建记忆；U0810 原生设置唯一权威 | 不删业务回执/绑定/目录选择等必要持久化，不损坏旧附件恢复 |
| 一张卡永远滚动最新固定长度文字 | U0345 按接受事件分段，U0803 保留成果＋有界活动区＋容量续卡 | 不丢阶段成果，不把排队成功或分段当任务成功 |
| 工作流四类扩展列为待办 | U0732 明确取消本轮开发/验收 | 不从旧“未完成”清单自动重启开发，也不改成已完成 |
| CLI 一键 curl 安装、未来多个 agent 的调研 | U0742 本轮先改权限展示；U0860 起其他 agent 仅作接口设计参考 | 不将讨论/可行性问题直接算实现承诺 |
| 只停某个 Linux Connector、单次群测试、某次证书点击授权 | 当次运维或测试授权，留在对应审计 | 不变成永久取消平台、任意发消息或普遍绕过浏览器权限 |
| 已读图片中的旧命令、引用消息、旅游/其他仓库正文、UI 开页通知、“hi”及催进度 | 历史背景、数据或操作状态 | 不当作新的 Gateway 功能或待执行命令；farming 是独立仓库，不纳入 Gateway 全代码检查 |

## 仍需保留的限制

- 本次只对照历史和文档，未重新逐行审查全部实现，也未重新执行所有 case。原 95 项部分覆盖保持不变，Herdr 的实测/版本边界仍在独立清单。
- DEL-09.5 与 DEL-09.6 的现有场景文字重复。保留 ID 避免破坏旧引用，不能把它们当两种不同能力；是否合并需核对各自测试和既有审计后迁移。
- 早期只存在截图的报告、已丢失图片，以及某个环境当时是否已安装扩展，不由文本复核认证。旧“已完成”答复不代替可验证的代码和回执。
- “有 case”“case 当时通过”“当前代码仍满足”“真实客户端看见”分别记录。新遗漏先进入功能合同和验证缺口，不为了凑齐数量升级状态。
