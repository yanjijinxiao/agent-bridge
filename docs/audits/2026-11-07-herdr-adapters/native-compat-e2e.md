# 原 Codex 兼容端到端回归（2026-11-08）

用户要求在 Herdr 改动后，另验 Codex CLI 与 Codex App。两条链路都使用探探真实钉钉渠道、同一候选 Gateway/Connector、原独立 App Server daemon，以及新建独立测试会话。代码集成通过不代替真实渠道；临时 CODEX_HOME + 假模型的原生协议测试另列。

| 场景 | Linux12 CLI | Mac Codex App |
| --- | --- | --- |
| 同版 Connector 重连原 daemon | 已完成 | 已完成 |
| /connect、/new 独立会话、目录查询 | 已完成 | 已完成 |
| 真实模型读写与最终结果 | 已完成 | 已完成 |
| 审批发送、一次性答复、确认后新卡 | 已完成 | 已完成 |
| 附件与 /prompt 合并顺序 | 已完成 | 已完成 |
| 运行中重启 Gateway/Connector，不重发输入 | 已完成 | 已完成 |
| /queue、/steer、/stop 原生操作 | 已完成 | 已完成 |

CLI 首轮实际文件及审批已核对原生历史，服务 processId=9955；精确 session/原生消息标识保存在本机验收证据，不公开设备凭据。测试用一次性 printf 审批，不保存命令规则，不批准用户其他任务。Mac launchd 首次 bootstrap 在旧服务退出过渡期失败，确认旧服务不存在、plist 有效后重试成功；Codex App 与 daemon 没有重启。

CLI 重连于 02:32 执行：Gateway 和 Connector 各重启一次，原生进程 9955 与原 turn 保持；75 秒命令开始/结束各写入一次。普通补充输入与原任务同 turn，队列输入另起下一 turn 且各 clientUserMessageId 唯一。钉钉旧卡转为阶段小结，新卡最终完成；队列最终卡也送达。独立 sleep 任务由 /stop 中断，最终卡无 /stop 控件。以上仅操作新建测试线程。

Mac 于 02:40 同样重启 Gateway 和其专用 Connector，原生进程 23722 及原轮次保持；命令退出 0，补充输入同轮，队列在随后轮次执行一次。02:42 的独立停止测试原生状态 interrupted，卡片已中断且无停止控件。全程没有重启 Codex App，也没有中断本会话或用户已有任务。

实测发现文件审批卡缺少具体文件清单：原生审批 RPC 只有 itemId，改动详情在 fileChange item。新增有界、严格 turn/item 关联读取与明确缺失提示；源码测试 59 项通过，真实渠道复验单独记录。新建隔离 Mac 目录继承该主机当前 read-only/granular 原生默认设置，文件创建触发一次性审批；未改主机或用户现有线程权限。

最终 v15 主库 3733 项：3643 通过、0 失败、90 跳过。独立原生专项 220/220 全部通过。真实 A15 文件审批已列出精确新增路径，批准后原任务完成；v14 的失败明细证据保留。CLI 7 条、Mac 8 条测试输入的 clientUserMessageId 全部唯一；两端 steer 与原命令同轮，queue 均只消费一次。Mac 解绑后显示 notLoaded 是原生卸载状态，已核对全部轮次终态，未误当运行中。

测试前探探私聊绑定及 Linux12 目录选择已经恢复。私聊实测不冒充多人群聊 @ 验收；目录会话为独立无项目资源，因此本组不声称证明项目 IDE；Mac/Linux 完整 IDE 通过单独浏览器记录证明。
