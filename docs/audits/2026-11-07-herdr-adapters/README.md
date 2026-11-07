# Herdr 适配与 Codex 兼容验收

更新：2026-11-08。源码基线 37b2a2c，产品版本 0.5.0。已完成新增 Herdr TUI/App 模块与共享调用链的四层检查、真实探探 IM 验证、Mac/Linux 浏览器 IDE 操作，以及原 Codex CLI/App 端到端回归。这里只报告记录过的范围，不宣称全仓历史代码已逐行审完。

## 当前证据

| 验证 | 总数 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: | ---: |
| 已上线制品主库完整回归 | 3735 | 3645 | 0 | 90 |
| Taskboard 发布回归 | 510 | 508 | 0 | 2 |
| 原生 Codex 二进制专项，另行启用 | 220 | 220 | 0 | 0 |
| 真实 Herdr + 生产 Connector 入口专项 | 2 | 2 | 0 | 0 |

90 项跳过仍保留在完整运行记录中，另行启用的测试不回写为该次运行已通过。20 项功能合同映射 700 个唯一通过用例，包含既有共享及原生专项测试，不等于 700 个新 case。

真实渠道另有证据：探探 → Linux12 Codex CLI、Mac Codex App、Linux12 Herdr TUI、Mac Herdr App。Codex 两端验证目录/新建、文件读写、审批回传及确认后续卡、附件合并、普通 steer、显式原生 queue、运行中重启 Gateway/Connector、停止及最终卡片。原生服务进程及原轮次未随转发进程重启，客户端输入标识没有重复。测试前的探探绑定与设备选择已恢复。

真实浏览器已验证 Mac/Linux 项目链接、编辑保存、集成终端、Git 和刷新重连。用户完成自签名警告后继续验收。手机不是上述核心链路的通用前提；没有把桌面证据写成手机测试。

## 新增实测缺陷及修复

- 原生审批可能先于 onTurnStarted 参与者持久化：统一接受回调屏障，失败不制造审批答案。
- Herdr composer 占位提示被误作新输入，丢失正文：忽略真实占位符；最终正文保留段落，稳定成果持久保留，命令日志以摘要显示。
- 文件审批 RPC 只有 itemId，卡片遗漏修改范围：按相同 turn/item 关联实时 fileChange，重连时有界读取；未提供明细时明确提示。真实 v14 证明等待审批的修改尚不在历史里，v15 的实时事件路径已显示具体文件并完成原审批。
- 输入完成与被动观察并发造成重复卡片、App done 状态参数不兼容、离线历史设备造成会话列表失败等此前实测修复继续保留，见模块文档和证据映射。

- 头头真实冷启动发现旧 local/remote-ssh-discovered 标识被遗漏，已按通信语义修复并补三个启动恢复 case；详见 [冷启动复现](managed-startup-recovery.md)。修复后全量回归与实际重新部署均通过，详见 [上线回执](deployment-verification.json)。

## 文档与审查入口

- [四层清单](production-checklist.md)、[真实渠道与浏览器验收](acceptance-2026-11-08.md)、[Codex 兼容端到端](native-compat-e2e.md)。
- production-requirements.json：功能、职责、实现散列、精确 case 名称和边界。
- production-read-ledger.json：65 个源码/脚本的完整模块或修改函数审查范围；wholeRepositoryReviewed=false。
- production-test-results.jsonl：700 个选定通过用例。root、taskboard、native、live-test-results 分别保留独立运行记录。
- production-verification.json：实机证据、日志散列、历史失败、构建及实际部署状态。
- [模块与函数职责](../../architecture/modules/agent-runtime.md)、[终端展示](../../architecture/modules/terminal-presentation.md)、[命令正交性](../../architecture/agent-command-compatibility-2026-11-07.md)。

before-e2e、before-completion 等文件是当时检查点，保留旧状态与散列；不能把它们当作当前结论。原始私聊/原生历史证据留在本机，仓库记录路径和散列，不发布连接凭据。

## 范围边界

Herdr 的终端 idle/done 不等于结构化业务成功；没有的原生模型/审批/queue/goal 语义不由按键伪造。上游无原子实例 CAS，最后核验之后的替换仍有窗口；无事件序号的轮询也不保证观察每次瞬时外部任务。

命令输出默认收成摘要，通过 /history 查看当前终端详情。当前模板没有原生点击折叠容器，也不声称有逐条命令归档。真实多人跨群、移动布局、所有 agent/浏览器/平台、主机断电不是本次实测范围。

头头、探探及相关 Connector 已统一上线 a8e4a72，已推送 main；npm 尚未发布。原绑定和浏览器授权保留，Mac/Linux Codex 原进程未重启。发布脚本另跑 Taskboard 顶层 510 项（508 通过、2 跳过），此前目录运行的 515 条还包含 5 个 helper 文件的加载记录，分别保留；详见 [部署证据](deployment-verification.json)。
