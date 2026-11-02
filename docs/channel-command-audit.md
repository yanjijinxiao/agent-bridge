# 渠道命令审计

内置命令统一登记在 `CHANNEL_COMMAND_REGISTRY`。解析别名、保留关键字和 `/help` 后端限制使用同一登记表；渠道扩展不能覆盖这些入口。微信、钉钉、飞书和企业微信共享业务命令，仅呈现方式不同。

| 处理结论 | 命令 | 本次处理 |
| --- | --- | --- |
| 保留，修复会话生命周期 | `/session`、`/sessions`、`/new`、`/history`、`/follow`、`/unbind`、`/leave` | 未绑定时普通消息只提示绑定；`/unbind` 明确解绑，`/leave` 为兼容入口；不删 session、不停止任务、不自动接回旧会话 |
| 保留，修复状态及策略 | `/status`、`/policy`、`/steer`、`/queue`、`/intervene`、`/stop` | 普通消息默认安全 steer；显式 queue 使用 Codex 原生队列；list/cancel 核对和取消本聊天回执；按实际持有者校验能力，不支持时明确拒绝；重启不重发未确认消息 |
| 保留，补齐帮助和保留字 | `/help`、`/answer` | 帮助显示后端限制；补充 `/answer`，避免与扩展冲突 |
| 保留，受原生版本或部署能力限制 | `/approve`、`/reject`、`/plan`、`/goal`、`/balance`、`/task` | 桌面与纯 CLI 使用同一 App Server 契约；原生版本不支持时明确报告，Taskboard 未启用时标注前置条件 |
| 保留 | `/project`、`/mode`、`/qa`、`/role`、`/model`、`/effort`、`/stream`、`/prompt`、`/memory` | `/stream` 控制跟随进度；其余保留原用途和权限约束 |

冗余入口 `/project add` 和 `/session new` 只保留为兼容写法，不作为独立工作流维护。`/project rename`、`/project delete` 只管理 Gateway 登记，不修改 Codex App 项目或删除目录，帮助和响应现在明确说明这一点。

已有的 `/bind`、`/resume` 等废弃入口不恢复；不要为了兼容重新引入第二套绑定流程。`/project` 保留为可选入口，因为指定项目新建、Taskboard 和知识库模式仍依赖项目上下文。

普通消息与显式介入统一使用选定主机 App Server 的 `turn/steer` 和 `expectedTurnId`；显式排队使用 `thread/queue/add` 原子追加。桌面与纯 CLI 部署共享这套契约，不使用私有 Desktop relay 或 exec 作为消息执行后备。默认策略为 steer，现有会话级策略保持不变；缺少原生版本能力时明确拒绝，不暗中换后端或普通发送。

历史测试覆盖渠道渲染、忙碌/悬空/旧轮次确认、退出与重启、新建与切换刷新、延迟快照不串线、关闭进度保留最终结果、Taskboard 不重写旧绑定，以及命令/别名登记。旧的两后端夹具不代表生产仍有两套执行实现，也不代替当前原生服务和真实 IM 验收。

`/follow sync` 是现有 `/follow` 的子操作，不增加顶级命令。它只读同步当前绑定，不开启已关闭的跟随、不创建新轮次；`/follow on` 即使已经开启也执行同步。`/follow` 和 `/status` 展示独立同步健康、成功时间及安全失败原因。共享协调器负责后台恢复与显式同步，各 IM 共用；纯 CLI 部署使用同一原生跟随接口。验证另覆盖重启去重卡片恢复、并发请求合并、单绑定超时、迟到读结果、绑定切换和失败呈现不误报成功。
