# Herdr 生产接入四层检查（进行中）

通过只表示列明的测试边界；未接入、上游无等价接口、未实测分别记录。

## 第一层：架构

| 要求 | 实现与证据 | 当前边界 |
| --- | --- | --- |
| Connector 唯一入口 | peer/index、registry、backend；connector-runtime-process 启动生产入口及 WS/JSONL | 隔离通过；未切线上 |
| 公共授权/共享/文件/IDE 一份 | execution-service、sharing、files、ide-service；agent-peer、runtime-sharing-ide | 两运行类型隔离通过；App 远端 machine 仅拒绝本机同名路径 |
| 输入不是原生轮次 | runtimeContract、RuntimeHandoff、runtimeInput；runtime-channel | screen 不解析动作/审批/成功，无伪 turn |
| 重启不换端或重发 | endpoint ID、handoff lookup、observation；SIGKILL、Connector 重启、Gateway 丢确认恢复 | 所列窗口通过；线上卡片骤停另验 |
| 两适配器共用业务 | 相同 Peer、共享及渠道场景参数化两种 runtime | 中断差异由 adapter 能力声明 |

## 第二层：模块与功能

| 功能 | 具体用例/文件 | 状态与缺口 |
| --- | --- | --- |
| 配对/隔离 | agent-peer：pairing refusal、another actorId/conversationId/accountId、fixed export、endpoint-qualified IDs | 隔离通过；真实多人跨群另验 |
| 目录/项目 | agent-runtime：空 workspace/space、inspection preserves project membership、ambiguous duplicated/distinct spaces；herdr-app-layout | 通过；全量 /sessions 分页及无 cwd 绑定仍需补 |
| 输入交接 | agent-handoff：落盘失败/并发/SIGKILL；agent-peer：source reuse、binding change、unknown write | 所列边界通过 |
| 独立回执查询 | agent-peer：read-only/exact-source、unknown、malformed/cross-resource；runtime-channel：lost Gateway ack after both sides restart | 通过；没有回执不再提交 |
| 来源记录修复 | inbound-receipts：terminal handoff recovery、terminal/native mixing | 精确 scope，无 turn/queue/recoveredNativeInput |
| 卡片/输出 | runtime-channel：真实 Bridge→Connector、IDE/@、action blocks、progress controls；runtime-observation：读中替换/撤权/通知未知/写盘失败 | 隔离通过；手机和跨参与者归并未验收 |
| 中断 | agent-peer：duplicate/concurrent；agent-runtime：App still-working；runtime-channel：能力区别 | App 请求语义通过；TUI 无通用结构化中断；App 实机未验 |
| 文件/共享/IDE | runtime-sharing-ide：owner share/revoke、实际附件字节、IDE 进程/HTTP；agent-peer：remote same-named cwd | 本机 cwd 隔离通过；跨 machine 未适配 |
| 配置/清理 | connector-runtime-config：旧默认/严格分型；connector-runtime-process：wrong core exits and closes socket | 隔离通过；未改用户配置 |
| 退出隔离 | connector-cleanup：逐 transport/readline/observer/IDE/host/runtime/lock 失败仍尝试其余；入口进程回归 | 本轮全库已覆盖前次小修；不等同完整主机骤停 |
| Codex 兼容 | peer-complete-contract、原生交互/回执/卡片、全库回归 | 见 production-verification；跳过不算通过 |
| 全部命令与应用表面 | runtime-command-policy 已接 IM help/status/history/stop 和原生能力拒绝 | 全 36 命令、别名、旧按钮、Web、Taskboard 未完成 |
| 创建/命名/关闭 | 设计分开终端生命周期和聊天归档 | 未接完，不能标上游不存在 |
| 持续跟随 | runtime-observation、runtime-channel：外部连续运行/重启/关闭/输入卡优先/stream/未知终态投递 | 隔离通过；多参与者合并通知和实机跨设备另验 |

## 第三层：函数与代码

production-read-ledger 记录真实阅读范围。检查配置身份、JSONL 写边界、RPC 反序列化、原 actor/chat/grant、异步前后守卫、指纹、磁盘、卡片及清理。

lookup 只查询；PeerRuntimeService 从当前 grant 派生原 send 操作；runtimeResponse 校验格式和预期目标；observe 读后核对原实例；recoverRuntimeAccepted 不改活跃或不同来源记录。service.ts 其他既有功能只列调用者检查及回归，不声称本轮全部重读。

## 第四层：静态、配置与发布

- README、探探教程、架构、模块、命令兼容、剩余工作与实机记录同步。
- Connector strict schema、runtime/build 字段分离、旧配置默认、坏配置和握手清理均有验证。
- 未新增专用前端包、发布脚本或平台模板；卡片沿用 IDE/复制/阶段区域，增加能力驱动控件。
- typecheck、临时编译、全库及逐项增量证据独立保存；不覆盖线上 dist。
- 头头、探探、原 Connector 未修改；未 push/npm 发布/重启。完整适配及实机验收前不称上线。

实际阅读、测试通过、真实设备验收不能混写。缺口保留于[剩余工作](../../architecture/remaining-work.md)。
