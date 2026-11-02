# Connector 契约修复与合入范围

运行修复：`2f4280e`；基线：`origin/main f108f81`。真实钉钉验收见 [实机记录](./real-validation.md)。修复针对 A1/A2 和重复的文件、浏览器授权端口；原审查报告和 reproduction.txt 保留为修复前证据。

## 已修复

- **A1 / 最终写前来源检查**：`CodexWriteGuard` 在同步 guard 上增加可选 `beforeWrite`。原生请求边界等待 Connector 回查 Gateway 原绑定/角色后，再检查设备 grant 与连接并写入。纯本地 guard 与请求仍在同一个同步调用栈，不增加异步间隙。覆盖续聊、介入、停止、精确 turn 中断、新建/命名/归档/恢复/删除及 goal。管理操作继续复用原原生 backend。
- `writeGuard: 1` 是协商门槛。新 Gateway 拒绝旧 Connector 写入；两端需要一起升级。已经接受/提交未知的回执不会变成“未提交”。最终检查阻止的 turn/start 则不会污染原生 unknown-start 状态，可以在重新获准后安全重试。
- **A2 / 审批未作答**：缺少 handler、回调错误、非法答案、断连均返回 undefined。只有明确且合法的选项才成为原生决定。
- 独立交互订阅经 Peer 转接 main 的观察器、fanout、request monitor 和渠道控制器。订阅退休不终止 turn；断连撤下旧 UI，重新订阅同一原生进程的待处理请求。原生已退休 handler 不再遮蔽观察器，未提交的审批可被重新播放；不自动重放旧答案。
- 实机复测发现运行内待审卡在断连后残留，补充 run 回调退休：以原请求对象报告 withdrawn/failed，旧卡退出待审；独立观察器重播后只保留新卡。新增正式回归，不修改渠道 Controller。
- 文件回传删除 `fetchOutboundFile/OutboundFile`，统一使用 `fetchOutputFile/OutputFileLease`。Peer 在公共参数上增加 account/conversation/thread scope，继续验证分块、校验和、工作区路径、grant 和发送前绑定，沿用公共媒体投递与 finally 清理。
- 共享文本页删除自己的 pending/browser 授权 Map，复用 `IDEAuthorization` 的浏览器证明、CSRF、持久会话和来源绑定。入口及浏览器会话持久化到资源配置旁的状态文件；共享授权到期时间是浏览器期限上限，每次资源访问仍重新核对 owner grant。仍是受限文本工作区，不提供终端。

## 自动化证据

- `npm run typecheck`、`npm run build` 通过。
- `npm test`：2823 项，2790 通过、33 跳过、0 失败。
- `peer-write-boundary`：真实 Bridge/角色状态与 WebSocket 反例；11 条原生 JSONL 写路径在等待中撤权后没有写入；resume 后撤权不发 turn/start，重新授权仅执行一次；旧 Connector 拒绝、无 handler/错误/断连不生成 decline，显式拒绝保持有效。
- `peer-interactions`：请求对象身份、host 重映射、错误范围、断线后 UI 退休与重新观察；真实 JSONL 同一进程跨 Peer 重连，没有默认答复，人工选择后仅一条原生 response。
- `peer-files`：统一文件端口保持大文件、身份、路径、篡改和失败清理覆盖；`peer-sharing` 验证持久浏览器重启后仍可访问、到期上限和撤销。
- 第一次全量发现两个本地 queue 回归，已修复并再次完整通过。没有通过修改原测试期望掩盖差异。

这些自动化不等价于第二个真实用户、真实群聊或所有 Codex 供应商的验收。跨网络核验不承诺撤权与设备写入之间的分布式原子事务；在原生准备等待结束后重新检查来源，恢复的是已审查的最后写前边界。

## Connector 适配矩阵

| 接口/功能 | 当前状态 |
| --- | --- |
| 主动连接、配对、选设备/会话、绑定/leave | 已接入；connect 不自动展开全部会话 |
| 续聊、steer、stop、精确 interruptTurn | 已接入，复用原生执行和最终 guard |
| 会话目录、历史分页、状态、模型、额度 | 已接入；目录和文件范围仍受资源准入限制 |
| 空会话创建、命名、归档/恢复/删除 | 已接入；删除要求已归档，固定 thread grant 不可创建其他会话 |
| goal get/set/clear | 已接入原生端口；不另建目标调度器 |
| 运行内审批/问答、独立交互订阅 | 已接入；不实现另一套卡片、审批或问答 UI |
| 附件上传/结果文件回传 | 已接入统一业务端口；传输层保留分块和设备路径校验 |
| Owner 准入、附加文件/工作区授权 | 实验功能；会话操作使用 main 的角色，资源范围另行校验 |
| 共享文本工作区 | 实验功能；复用持久浏览器授权，尚非完整 code-server |
| 原生 queue、capacity/system-error 自动恢复 | 未开放；显式返回不支持，不在本次修复中扩大功能 |
| skills/MCP 目录、dynamicTools/structuredOutput、owning UI nativeSettings | 未开放；能力位为 false 或调用明确拒绝 |
| 完整 code-server / Taskboard 远端全功能 | 未验收，不宣称与 local/SSH 全部等价 |
| 远端消息 Channel 双向入口 | 仍为协议原型，正常启动配置未接线 |

未开放项目是实验 Connector 的明确范围，不是已通过验证的“完整原生协议适配”。如果合入目标要求所有 NATIVE 能力等价，这些项目仍须开发后另行验收。

## 通用修改与发布约束

- 会话命名、归档/恢复命令、空会话与项目别名修正作用于支持这些能力的所有 backend，并非被 Peer 开关隔离。原有回归随全量执行，应在 PR 中单独列明。
- 本轮公共层新增的是最终 guard 原语、交互退休/重播修正、文件 scope 和可限期的持久浏览器授权；没有改写渠道渲染、复制框、主 Web UI 或 code-server 流程。
- 默认不开启 Peer，需显式配置。旧共享委托仍需重新批准，不自动扩大权限。升级先备份当前状态、准备依赖和构建制品，通过隔离冒烟后再切换；不要用恢复旧授权状态回滚。
- 本轮不执行 main 合并或推送。本轮实机记录单列，不能用先前 6b9bcde 的记录替代。
