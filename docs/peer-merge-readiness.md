# Connector 合入验收（2026-11-02）

## 结论与范围

当前 Connector 可按**默认关闭、显式配置启用的实验功能**合入 `main`。本轮没有执行主分支合并。验收基线为 `origin/main f108f81`；23:12 再次 fetch，远端基线未变化。运行修复提交为 `6b9bcde`。

核心范围是机器人聊天通过主动连接的设备选择、绑定和执行原生 Codex 会话。多人共享、真实群聊及共享文本工作区继续标注为实验功能，第二个真实用户和真实群聊尚未完成实机验收。既有卡片、复制控件、审批与结果投递继续复用主分支。

## 共享权限收敛（后续修订）

移除 Connector 分支单独的 `read / chat / control` 委托档位及 `--manage` 参数。共享只负责资源准入，Gateway 的角色计算恢复为 `main` 原实现；发送、介入、停止、审批和管理复用现有 `/role` 与审批控制器。文件回传和 Web 编辑器读写继续由 owner 单独授权，Connector 保留身份、会话、目录、过期和撤销校验。

批准命令为 `/share approve 申请ID [--ide read|write] [--files] [--hours 24]`。Gateway 与 Connector 的共享能力版本同步升级为 2；旧委托不自动转换，需要访问者重新申请、owner 重新批准。所有权、目录确认和设备配对保留，避免旧只读访问自动获得续聊能力。

此修订的类型检查、完整构建通过；共享专项 18 项通过；全量 2798 项，2765 通过、33 跳过、0 失败。新增回归通过实际 BridgeService 和回环 WebSocket 验证角色变化、禁止自行提权、参与者无法审批、controller 可以审批/停止/管理、不能转授权，以及旧委托迁移和版本兼容。原生后端仍为模拟，不将此结果视为第二个真实钉钉用户验收。

此修订尚未部署到探探；下文的真实钉钉和故障验收仍对应 `6b9bcde`，不作为本次权限修订的实机证据。

## 本轮修复

主分支新恢复逻辑按 `gateway-…` 原始输入 ID 查找原生历史，而 Connector 一直将输入转换为带账号、聊天和用户作用域的 `peer-…` ID。此前自动化没有覆盖两者组合，发生“原生接受已发生、Gateway 接受回执未落盘”的崩溃时无法确认原任务。

新增可选的后端只读恢复接口：Peer 根据原身份计算既有原生 ID，使用该身份的有效授权读取设备历史，然后复用主分支的完整分页、精确 ID 和唯一轮次校验。保留既有编号和去重记录，兼容升级前的未确认任务；不重发输入，不猜测相同文本，也不借用其他人的设备权限。本地和 SSH 后端沿用原恢复规则。

新增回归覆盖：Connector 重启后恢复原 ID、错误账号/聊天/用户/会话被拒绝、缺失身份保持未知、歧义与不完整历史不确认、AccountManager 将未知回执持久化为已接受、本地和 SSH 不改变输入 ID。

## 自动化与制品

- 类型检查、完整构建通过。
- 定向恢复 / Peer 执行回归：33 项通过。
- 全量：2795 项，2762 通过、33 跳过、0 失败。
- 制品 `peer-merge-6b9bcde.tar.gz` 的 SHA-256：`2c6dd7513e9e31a97d575c5373f66a031ffdea82fb99aedf117a48e8f3521522`；两端上传后校验一致。
- 两端运行目录均为各自工程下 `releases/peer-merge-6b9bcde`。锁文件与已验证依赖一致，制品、依赖和隔离冒烟在实际服务停止前完成。首次 Gateway 切换约 3 秒。

## 真实钉钉与故障验收

拓扑：探探私聊 → 29 Gateway → WSS → 12 Connector → 独立 Codex daemon。消息由已授权的 `dws` 用户身份发送，回复通过个人事件订阅与精确消息查询确认；没有使用模拟机器人。正常测试会话保持为 `01a19b25-5fa7-7333-b4d1-5d553936898e`。

| 场景 | 证据与结果 |
| --- | --- |
| 正常执行与结果卡 | `msg0SNsLN7kS+u5hhOgYHBwbA==` 更新为 `MERGE-6B9BCDE-NORMAL LINUX-CONNECTOR-SEED-9E713` |
| 接受回执丢失后 Gateway 崩溃 | 临时回环 WebSocket 代理仅对指定测试任务拦住 `onTurnStarted`，并暂时阻断历史观察；设备已接受后对 Gateway 执行 SIGKILL。磁盘回执确认为 `submitting`，没有 turn ID |
| 原生任务独立完成 | 目标原生 turn 为 `01a19ccd-9839-79f3-9862-995e4ca131e0`，原生记录中该任务仅启动一次；`recovery-6b9bcde.txt` 仅一行。turn context 确认为 `deepseek-v4.1-flash-1017` |
| 重启自动补齐 | 解除观察阻断并启动 Gateway 后，原回执依次成为 `accepted`、`handled`，含同一 turn ID 和 `recoveredNativeInput: true`；没有重新发送用户输入 |
| 实际结果补投 | `msgn8ysEIr6QVncu1oYmCqLEQ==` 为 `MERGE-6B9BCDE-CRASH-DONE`；再次 SIGKILL/启动 Gateway 后，目标 turn 的最终投递记录仍只有一次 |
| 恢复直连后文件回传 | 实际收到附件 `recovery-6b9bcde.txt`，消息 `msgzUx4/68YycX7q46GtgbasA==`；对应结果投递成功。未独立从钉钉下载后复算附件哈希 |
| 执行中重启 Connector | 原生命令写出专用检查点后 SIGKILL/启动 Connector；daemon PID `9955` 保持存活，结果文件只有一行。断线被记录为已接受任务的观察中断；重连后原卡 `msg892yOBT02tbDlB0/PNtMAw==` 更新为 `MERGE-6B9BCDE-CONNECTOR-DONE` |

## 容器进程锁约束

第一次强制重启暴露了原有 PID 进程锁与容器 PID 1 复用的问题：旧进程已停止，但新容器将同一个 PID 判为仍存活。确认原容器停止后保存并清理旧锁，测试 Gateway 启动脚本改为 `--pid container:<外层开发容器>`，与 Connector 一样使用稳定 PID 命名空间。随后再次 SIGKILL/启动无须清理锁，服务恢复正常。

本轮没有改写主分支进程锁模块。其他容器编排方式需要保证进程锁的 PID 命名空间语义一致，或由编排器在确认旧实例已停止后处理旧锁；不能无条件删除服务锁。

## 收尾与已知边界

- Gateway 与 Connector 已恢复正常直连；故障代理、临时配置已清理，隔离冒烟实例已停止。保留升级前容器用于回滚，不通过恢复旧权限状态进行回滚。
- 本轮重点验收了当前基线的崩溃恢复与文件接口；真实审批、绑定/解绑、新建/归档和复制按钮的既有证据见 `peer-main-reuse-review.md`、`peer-dingtalk-linux-validation.md`。
- 独立外部任务审批、断线期间错过的审批回调、完整 code-server、其他系统版本及长时间压力运行不在本轮验收范围。未开放的 Peer 能力仍明确拒绝，不回退到 Gateway 本机。
- 当前实机 TLS 使用内部测试 CA 和短期证书，长期部署须维护证书续期；本次测试没有关闭证书验证。
