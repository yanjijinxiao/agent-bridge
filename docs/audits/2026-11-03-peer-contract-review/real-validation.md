# 修复后的真实钉钉验收（2026-11-03）

运行修复为 `2f4280e`，包含 `a41fe42`、`c13f5e2`。主分支基线 `f108f81`。制品 `peer-fix-2f4280e.tar.gz` SHA-256 为 `cfed2be85f57ae40ec264dc8024875d2a8742e8500769b278bc415740bbc118f`，两端校验一致。类型检查、完整构建通过；全量 2823 项，2790 通过、33 跳过、0 失败。

## 环境和切换

探探私聊 → `11.158.199.29` Gateway → WSS → `11.159.100.12` Connector → 同一独立 Codex daemon。两端目录分别为原工程下 `releases/peer-fix-2f4280e`。原生模型实查为 `deepseek-v4.1-flash-1017`，原生 daemon PID `9955` 始终存活。

制品、依赖锁文件比对、依赖准备和隔离冒烟均在服务切换前完成。沿用 main 发布门禁和稳定 PID 命名空间；最后一轮切换约 4.46 秒。原容器及配置备份保留，常用启动脚本已同步到验证版本。没有恢复旧授权状态或关闭 TLS 验证。

## 实际结果

| 场景 | 证据 |
| --- | --- |
| 原会话续聊、模型执行、结果卡 | 第一轮修复 `c13f5e2` 的卡 `msgqVgbkaTNqcdqtrar5rz6CQ==`，精确查询包含 `PEER-FIX-C13F5E2` 和 `LINUX-CONNECTOR-SEED-9E713` |
| 统一文件回传 | 第一轮收到 `peer-fix-c13f5e2.txt`，消息 `msgJKMOkBiynxWgVW0vY6Kkvg==`；源文件逐字节为预期首行 |
| 真实测试发现旧卡残留 | `c13f5e2` 崩溃重连后 A5/A6 同时待审；原生未默认拒绝，但旧运行卡没有退休。修复为 `2f4280e`，补入 `peer-write-boundary` 回归后重新完整测试和部署 |
| 最终版本待审时崩溃 | 专用会话 `01a19d44-ba8a-7431-b5ff-1273188d119d`，原生 turn `01a19d4b-802b-7841-bd13-cfaa7b81017d`，明确处于 `waitingOnApproval`。A7 卡 `msgf6sfceRqlZQzMJ+eZMk2cA==`；目标文件不存在时 SIGKILL/启动 Connector，daemon 不重启 |
| 原请求恢复及旧卡退休 | A7 失效通知 `msgEw1JDU5SyxMNUg+O0Kx+wA==`；新卡 A8 `msgouMw1K+HLgBtiH3DJ57w/Q==`。Gateway 待审 API 仅剩 A8，独立订阅恢复为 subscribed |
| 旧编号确实失效 | 通过钉钉发送 `/approve A7`，返回 `msgxk0m81NKYhFrwtBTEZXXoQ==`，明确编号不再待审；此时目标文件仍不存在 |
| 新编号允许一次 | 发送 `/approve A8`，原生确认消息 `msgKQXSQ39v6L4Zrcay0bSJGQ==`；完成卡 `msg9zIqiPURIouH6X5yt2Soiw==` 包含 `PEER-APPROVAL-2F4280E-DONE` |
| 任务没有因重连重发 | 该命令使用追加写入，源文件内容恰好为一份 `PEER-APPROVAL-2F4280E`，没有重复标记 |
| 最终制品的文件回传 | 恢复原测试会话后收到 `peer-approval-2f4280e.txt`，消息 `msgwUO+eoPuIhRD6xTRzrzCrQ==`；完成卡 `msgtrbgPzgHfkC3DfUdC46VjQ==` 精确查询包含 `PEER-FINAL-FILE-OK` |

专用审批会话第一次把文件动作块误认为工具；第二次模型输出的是 `json` 代码块而不是 `codex-im-gateway-actions`，因此没有触发发送。这两次不计为文件验收成功。恢复原会话后实际收到附件才计为通过。未从钉钉下载附件后重新计算哈希，不将设备源文件校验等同于客户端文件逐字节校验。

## 收尾和结论边界

- 探探恢复绑定原会话 `01a19b25-5fa7-7333-b4d1-5d553936898e`；待审列表为空，原生订阅正常。
- 本次隔离冒烟实例已停止，按本次 subscribe_id 取消 dws 事件订阅；dws 返回个人 bus 已停止，未手动终止其他进程。测试数据留在专用目录中。
- 本轮补验了 A2 的真实崩溃重连、旧卡退休和人工批准。A1 的中途降权证据仍是自动化的真实 Bridge/Peer/JSONL 测试，不包装成真实第二用户测试。
- 没有再次验收真实群聊、第二个真实用户、完整 code-server、所有操作系统和供应商；手机复制按钮沿用用户此前明确反馈，本轮没有代替用户点击。
- 按默认关闭、显式启用的实验 Connector 范围，已修复本轮确认的阻断问题并完成合入准备。不是全 NATIVE 能力等价验收，未开放能力仍见修复矩阵。本轮未合并或推送 main。
