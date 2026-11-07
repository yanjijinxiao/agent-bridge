# Agent Bridge 运行接口调研：Herdr TUI / App 接入与未来适配边界

日期：2026-11-06。状态：源码与官方协议调研、设计提案；不是已经实现或上线的功能说明。

2026-11-07 补充：[命令与业务能力契约](agent-command-compatibility-2026-11-07.md)核对全部 36 个命令和关键子操作，补上本篇未完整覆盖的权限、目标解析、Taskboard/QA/扩展及帮助/按钮/执行一致性。本篇是协议基础，不能单独视为完整实施设计。

2026-11-07 实施增量：[两套适配的模块/函数/代码设计](herdr-adaptation-design.md)及[四层检查](../audits/2026-11-07-herdr-adapters/README.md)记录已实现的底层适配和交接模块、55 项定向回归及 12/Mac 实测。生产 Connector/命令/呈现接线未完成；下文原始调研结论不视为上线声明。

## 1. 本次范围与结论

本次新增接入目标只有 **Herdr TUI 与 Herdr App**。现有 Codex 能力需要保持；Claude Code、OpenCode、Qwen Code、Qoder、Gemini CLI、Pi 用于检验抽象是否通用，不进入本次开发范围。

本次核对改变了此前过于简单的“把 CodexBackend 改名并增加适配器”的方案：

1. **Herdr TUI 与 App 并不共用一套后台协议。** TUI 使用自己的 Herdr server；App 使用 herdr-core，并另外提供窗口控制 socket。它们需要不同的协议适配器，但应进入同一套 Gateway 业务流程。
2. **终端不是原生对话。** Herdr 管理终端、进程及状态；Codex App Server 管理 thread、turn、item、结构化审批。Herdr 中运行 Codex CLI，不代表 Herdr 对外暴露了该 Codex 的 App Server。
3. **统一的应是资源身份、交接、观察、权限和恢复规则；具体能力必须保留差异。** 不能把“字节写入终端”包装成“原生 turn 已接收”，不能把终端屏幕包装成完整聊天历史。
4. **连接协议与执行生命周期分开。** 相同 JSONL/stdio 外观不代表同一种协议；能恢复历史也不代表能重连原执行进程。
5. **现有 Codex 接口不是足够通用的基础。** Connector 已经有运输、授权和交接基础，但业务契约、状态、审批、目录和回执仍大量依赖 Codex。

本报告没有启动真实 Herdr、Claude 或 OpenCode 任务，没有重启线上服务。Herdr 结论基于固定源码快照；其他参照主要基于官方文档和公开 SDK 源码。后文验收场景均为待实现、待运行，不能计入已有测试通过数量。

## 2. 证据版本与核对范围

| 对象 | 本次证据 | 范围与限制 |
| --- | --- | --- |
| Agent Bridge | `37b2a2ca8b467528167bc62cd54ce3cfce8b287e`，package 0.5.0 | 核对运行接口、Connector 注册和执行、交互、版本、现有合同与测试；不是全仓逐行审计 |
| Herdr TUI | 0.9.5，`ee5bfb5041bb3e4a49d591c72308aae3c81ecdde` | schema、API dispatch、prompt 输入实现、wait、订阅、PTY 提交回执 |
| herdr-core | 0.1.18，`c6b316f87c33e6f2ab1a1ceea3e3461e2b6bb61a` | OpenRPC、握手、终端 API、状态、事件、流协议、文件及生命周期说明 |
| Herdr App | 0.1.13，`cfcf836404f932817f10f88455c33e33c94fd1df` | core client、窗口 socket、布局文档、远端标识和同步 |
| 本机 Codex CLI | 0.164.0 | 实际运行 schema 生成器，包含 experimental；不代表线上所有主机版本相同 |
| Claude / OpenCode / 其他 | 2026-11-06 查询的官方文档，Claude 另核对 SDK transport/query 源码 | 未运行这些产品的跨端集成测试；文档支持不等于本机安装支持 |

本机 Codex schema 生成结果中有 175 个 ClientRequest 方法、11 个 ServerRequest 方法、85 个 ServerNotification 方法。包含 `project/list`、`thread/settings/update`、`thread/queue/*`、`thread/goal/*`。**不能再用“App Server 没有项目接口”的旧假设指导设计。** 此处生成时开启 experimental；方法出现在 schema 不等于每个已部署服务都开放该能力。

生成文件 SHA-256：

- ClientRequest：`503d09a12ae36fca152e044877d22e93b0094c2d08c3a53ed731f3c8cf33b9ce`
- ServerRequest：`3d7bc481f84dc042984a74420e65c5a8d3c423f37a91b7d5df2365c903a12ac6`
- ServerNotification：`e21533d2f9bd7ad554f8aeb1f8ac3fac912668ff0a02ceed2c82bb32e55538a6`

源码入口及固定链接见第 10 节。所有接口设计结论是基于这些证据作出的建议，不冒充供应商承诺。

## 3. 现有实现到底抽象到了哪里

生产主链是：渠道/管理入口 → Connector backend facade → Peer RPC → 设备上的 Codex gateway → App Server runner → 原生服务。这个方向可以保留；Connector 不应重新实现每种 agent 的聊天业务。

但当前下列契约需要调整：

| 现有入口 | 当前假设 | Herdr 暴露的问题 | 建议 |
| --- | --- | --- | --- |
| `src/codex/backend.ts` 的 backend ID | `exec` / `app-server` | 名称不能区分运行产品、协议与传输方式 | 分离 provider、协议版本、endpoint、运行实例身份 |
| `CodexExecutionScope` | host + thread + turn，均必需 | Herdr 终端未必有原生对话 ID；core 的 turn 是状态计数 | 通用资源引用 + 可选的原生 conversation/execution 引用，保留类型 |
| `CodexInputReceipt` | 只有 accepted，必须有 threadId/turnId | 无法表示 PTY 已写入、程序未开始、提交结果未知 | 分开提交结果、确认层次、执行关联证据 |
| `CodexThreadState` | Codex runtime/turn 状态；部分桌面专用字段 | 终端存活、agent 工作、观察断线不是一个状态 | 运行资源、任务、观察连接、结果投递分别建模 |
| `CodexSessionCatalog` | 来源固定为 desktop/storage/rollouts；列表是 threads | Herdr 有 workspace/tab/pane/terminal；App 有空 space 和远端布局 | 有类型的目录树；记录来源、完整性、分页和不可达节点 |
| `CodexRunnerInput` 回调 | onTurnStarted、CodexPublicActivity、Codex 审批对象 | 终端重绘、状态提示不能转换为假的 tool/item 事件 | 公共事件信封 + 有类型的 payload；供应商解析留在适配器 |
| 原生设置 | Codex sandbox、approvalPolicy、reviewer 等枚举 | 其他产品的模式和有效范围不同 | 设置有 schema、作用范围、当前值与能力；不把 Codex 枚举上移 |
| `src/peer/execution-service.ts` | 固定方法枚举、位置参数数组、Codex run schema | 仅改 backend 名称仍会被 wire schema 拒绝 | 版本化、具名且经过校验的资源/操作请求；适配器在设备侧 |
| `src/peer/registry.ts` | backend ID 固定；能力多为 boolean | 支持 history 不能说明是 transcript 还是 screen | 能力必须说明模式、保证和限制 |
| `src/peer/interaction-service.ts` / Codex interaction | 原生请求方法与决策值依赖 Codex | blocked 提示没有可直接答复的审批 request ID | 分开可答复交互和需要人工关注的状态 |
| `serverIdentity()` | processId | PID 重用、远端同号、core 稳定 ID、连接重建 | 区分稳定 runtime ID 与本次服务/资源 generation |

应当保留的现有基础：写前身份核验、来源绑定和撤权、原生回执核对、未知输入不重放、Connector 断连恢复、文件/IDE 的独立授权、阶段成果与实时窗口分离、最终结果投递去重。

已有 `peer-complete-contract.test.ts` 检查 52 个 backend port 的运输策略，且有 queue 回调、来源核验和接收分类用例。它证明现有 Codex facade 的一些边界有覆盖，**不能证明终端接口或另一种 agent 协议已经适配**。

## 4. Herdr：三个接口，两个执行后台

### 4.1 Herdr TUI：自己的运行服务与公共 socket

TUI 的公共协议是 Unix socket / Windows named pipe 上的 JSONL，使用 `id`、`method`、`params`，方法是点分命名。不要因形状相似就直接复用 Codex 的 RPC codec：错误格式和方法、事件语义不同。

官方提供 `herdr api schema --json`。公共 API 有独立的协议稳定性说明；内部 attach/handoff 的二进制协议不应成为第三方集成入口。[TUI Socket API](https://herdr.dev/tui/docs/socket-api/)

主要对象与方法：

- 目录：`session.snapshot`、`workspace.list/get`、`tab.list/get`、`pane.list/get`、`agent.list/get`。
- 操作：`agent.start`、`agent.prompt`、`agent.send_keys`，以及 pane 输入和布局操作。
- 观察：`agent.read/explain`、`pane.read`、`events.subscribe`、`agent.wait`。
- 状态：idle、working、blocked、done、unknown；AgentInfo 另有 terminal_id、原生 agent_session 引用、interactive_ready、state_change_seq、completion_seq 等。

输入不能统一成“返回成功就是 agent 接收”：

1. pane 输入/启动类响应可能只表示输入队列接纳。
2. 本次源码中 `agent.prompt` 的非 wait 路径会等待 PTY actor 完成文本与 Enter 的写入，再返回。它比单纯入队更强，但仍没有 Codex 那样的原生 userMessageId/turnId 接收证明。
3. `agent.prompt` 的 wait 路径还观察活动变化和目标状态，返回的是 AgentInfo；超时或 stalled 不自动等于输入未送达。
4. 已 blocked 的 agent 会被明确拒绝，不应改走低层 send_keys 把用户的普通消息打到审批对话框里。

这些区别可在 `src/app/api/agents.rs`、`src/pty/actor/unix.rs`、`src/api/wait.rs` 复核。[固定版本输入实现](https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/src/app/api/agents.rs)

wait 会固定解析到的 pane occupant，避免替换后的程序满足旧等待。但公共 prompt 参数并没有 Bridge operationId 幂等键或通用的 expected resource generation 条件。适配器的写前核验不能被描述成上游已提供原子 compare-and-write。

事件恢复也不能照搬原生聊天日志：先订阅，再取权威 snapshot 并核对；事件用于使缓存失效。`events_lost` 要重新订阅并取 snapshot。内部有界事件保留不是可供任意离线客户端永久重放的历史接口。[固定版本订阅错误处理](https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/src/api/subscriptions.rs)

### 4.2 Herdr App 的执行接口：herdr-core

herdr-core 是另一套实现。握手 `hello` 返回 generation、version、稳定 core ID、methods、features。接口使用 JSON-RPC 2.0；普通模式是 JSONL，终端 attach 使用协商后的二进制分帧。`hc connect` 还能通过 stdio/SSH 使用同一协议。[Core 协议](https://github.com/herdrdev/herdr-core/blob/c6b316f87c33e6f2ab1a1ceea3e3461e2b6bb61a/schema/README.md)

该版本明示 preview、generation 1、0.x，同时有 released OpenRPC 兼容检查。应按实际 generation、方法与 schema 验证兼容，不能笼统称为“已经永久稳定的 App Server”。

主要能力：

| 能力 | 原生接口与含义 |
| --- | --- |
| 运行资源 | `terminal.run/list/get`；本地或 `machine/terminal`；默认列表不含所有 finished 项 |
| 输入 | `terminal.send` 发送文本与提交键；`terminal.keys` 发送键；不是模型消息 API |
| 输入证据 | send 返回 status、turn 计数、started（true/false/null）、可选 wait 结果 |
| 观察 | `terminal.read`、`terminal.attach`、`events.subscribe` |
| 等待 | `terminal.wait`，reason 包含 status、exit、output、timeout、not_started 等 |
| 中断 | `terminal.interrupt` 返回实际观察到的 stopped/exited/still_working/unknown；不能一律报“已停止” |
| 强终止 | `terminal.kill`，与 interrupt、detach 是不同操作 |
| 文件 | `terminal.put` 放文件到终端所在机器，返回路径但不自动输入；另有 file.read/write/edit |
| 远端 | machine 管理、远端终端地址；必须保留资源实际所在机器 |
| 共享文档 | `doc.get/set` 有 version/CAS；它是任意 JSON 文档存储，不是原生 project/list |

[Core 方法与类型](https://github.com/herdrdev/herdr-core/blob/c6b316f87c33e6f2ab1a1ceea3e3461e2b6bb61a/crates/herdr-core/src/api/types.rs)

core 有 `turn` 字段，但它在状态离开 working 时递增，包括进入 blocked；不是某条用户输入的原生任务 UUID，也不自动证明任务全部完成。`started: null` 表示没有状态报告，不能当作失败；`started: false` 也不授权自动重发。

状态主要来自程序的 OSC 7501 报告；blocked 的 kind 可以提示 permission/question/auth，但这不自动提供审批 ID、完整操作内容、选项和可确认的答复接口。这里不能凭一个状态词做“批准”按钮。[状态实现](https://github.com/herdrdev/herdr-core/blob/c6b316f87c33e6f2ab1a1ceea3e3461e2b6bb61a/crates/herdr-core/src/status.rs)

两个容易遗漏的副作用：

- `terminal.attach` 有 observe 模式。Bridge 后台观察应使用它，避免抢终端尺寸、焦点和输入所有权。初始 repaint、后续输出、尺寸变化必须由终端解释层处理，不能全部作为新的聊天文本追加。
- `terminal.read(lines > 0)` 在全屏程序上可能通过滚动拼接历史；不是纯旁观读取。后台进度采样优先只读当前屏幕/observe stream，不能周期性滚动用户的终端。[read 实现](https://github.com/herdrdev/herdr-core/blob/c6b316f87c33e6f2ab1a1ceea3e3461e2b6bb61a/crates/herdr-core/src/api.rs#L356)

事件订阅提供 snapshot/seq；落后会收到 `missed` 和新 snapshot。它提供重新对齐状态的机制，不提供 Bridge 丢失期间所有任务结果的永久日志。恢复时要重建观察状态，不重发输入。[事件实现](https://github.com/herdrdev/herdr-core/blob/c6b316f87c33e6f2ab1a1ceea3e3461e2b6bb61a/crates/herdr-core/src/events.rs)

生命周期必须精确区分：

- 关闭 App 窗口不等于停止 core 的程序；关闭 pane/tab 则可能终止对应程序。
- `server.restart` 是计划重启，允许 holder 继续运行程序，由新 core 接管。
- `server.stop` 会停止 core 及其程序。
- kept terminal 在进程丢失后恢复 fresh shell，不证明原 agent 任务继续；系统重启/崩溃不能按“计划重启必保活”处理。
- Gateway/Connector 断开观察，不能顺带调用上述停止/重启方法。[Core 方法声明](https://github.com/herdrdev/herdr-core/blob/c6b316f87c33e6f2ab1a1ceea3e3461e2b6bb61a/crates/herdr-core/src/api.rs)，[App 生命周期说明](https://github.com/herdrdev/herdr-app/blob/cfcf836404f932817f10f88455c33e33c94fd1df/README.md)

### 4.3 Herdr App 的窗口接口

App 另在 `$HERDR_APP_HOME/herdr-app.sock` 提供单行 JSON 控制协议，例如 ls、status、do、shot、raise。它用于窗口、space、tab、pane 的展示与操作，不是执行服务，也没有 core 那样的 OpenRPC 兼容承诺。[窗口协议实现](https://github.com/herdrdev/herdr-app/blob/cfcf836404f932817f10f88455c33e33c94fd1df/src/control.rs)

App 把各机器的 spaces/tabs/splits 存在各自 core 的 `herdr-app` 文档里；使用 `doc.get/set` 和 CAS 同步，焦点与 zoom 另属具体 viewer。

因此完整接入 App 时应：

- 通过 core 控制和观察执行；通过 App 的目录/视图接口补齐界面组织信息。
- App 窗口关闭时，core 仍可观察；需要目录时，可读取已知版本的布局文档，明确这属于 **App 专有文档格式**，不是 core 通用目录协议。
- 空 space 必须保留。不能只用 terminal.cwd 反推所有项目，造成此前 `/sessions` 空项目和本地项目丢失的问题。
- 创建终端与把终端放进 App 某个 pane 是两个动作；仅 `terminal.run` 成功，不等于已经显示在用户指定的 App 布局中。
- 布局写操作优先走 App 命令；不能无版本控制地覆盖 `herdr-app` 整个文档。

[App 布局模型](https://github.com/herdrdev/herdr-app/blob/cfcf836404f932817f10f88455c33e33c94fd1df/src/mirror.rs)，[布局 CAS 同步](https://github.com/herdrdev/herdr-app/blob/cfcf836404f932817f10f88455c33e33c94fd1df/src/mirror_sync.rs)

## 5. 与其他产品的接口比较

### 5.1 总表

| 产品/入口 | 实际程序接口 | GUI 与 CLI 的关系 | 对设计的检验 |
| --- | --- | --- | --- |
| Codex App Server | 双向 RPC；thread/turn/item、审批与事件；部署可用 stdio 或已支持的共享服务连接 | 同协议不保证同一进程；必须指定并核对同一核心 | 结构化对话、原生执行 ID、原生设置及精确回执 |
| Herdr TUI | Herdr server 公共 JSONL socket | TUI 是其客户端；不是 herdr-core | workspace/tab/pane、终端与 agent 状态、受限历史 |
| Herdr App | core JSON-RPC + attach frames；另有 App 窗口 JSON socket | 窗口与执行分离 | 两种职责接口、远端资源、观察者、共享布局 |
| Claude Code CLI | Agent SDK 包装 CLI 进程；stream-json 与控制请求 | 不能凭 CLI SDK 接口假定可附着 Desktop 正在运行的 session | 子进程生命周期、结构化工具/审批、resume 与 live reconnect 分开 |
| Claude Code Desktop | 官方文档没有提供对应的第三方桌面自动化接口 | Remote Control 是官方跨端会话功能，不是公开的本地 App Server 替代物 | “有 App”与“有公开可附着服务”必须分开记 |
| OpenCode CLI/TUI | HTTP OpenAPI server + SSE；还有 TUI 控制 API | TUI 启动 server；另起 serve 会新建 server | REST/SSE、message ID、状态重同步、服务地址固定 |
| OpenCode Desktop | 可连接现有 OpenCode Server URL | 官方明确给出 Desktop 连接 WSL server 的用法 | GUI 与无头可以共用一套业务适配器，仅连接/部署不同 |
| Qwen Code | serve HTTP/SSE，内部 ACP；另有 SDK/CLI | 已有 Desktop/WebShell；按对应 daemon 能力核对 | 多 workspace 所有权、事件 epoch/有界重放、会话加载副作用 |
| Qoder CLI | TS/Python/Java Agent SDK，CLI JSONL/control；另有 ACP 模式 | 有图形产品，但本次没有确认可附着其已有 GUI 会话的公开接口 | SDK runtime/transport 与桌面附着能力分离 |
| Gemini CLI | ACP over stdio | IDE 集成不能直接等同独立 GUI 的共享服务 | 可选的客户端文件/终端能力、协议握手 |
| Pi | in-process SDK 或长驻子进程 JSONL RPC | 不借此推断独立官方桌面端 | 进程内、子进程、独立 daemon 三种所有权模型 |

### 5.2 Codex：保留强语义，但不把它当万能标准

Codex App Server 已经有结构化 thread/turn/item、`turn/start/steer/interrupt` 和原生交互请求。Bridge 应保留精确 turn 关联，不能为兼容 Herdr 把已有能力降为屏幕抓取。官方 schema 可以从实际二进制生成；传输方式与实验能力应以目标版本为准。[Codex App Server](https://learn.chatgpt.com/docs/app-server)

本机 schema 同时证明项目、原生 queue/goal、设置接口存在。未来通用接口应让这些成为有类型的可选能力，保留原生数据，不要求 Herdr 编造对应实现。现有“已接收输入不重放、设置直接交给原生服务”的约束继续成立。

### 5.3 Claude Code：CLI/SDK 可集成，Desktop 不能先假定可接入

官方 Agent SDK 运行 Claude Code binary，提供消息流、会话、工具、权限和用户输入处理；不同于只调用模型的 Claude Client SDK。[Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)，[审批和用户输入](https://code.claude.com/docs/en/agent-sdk/user-input)

SDK 的 subprocess transport 使用结构化输入输出，控制请求有自己的 request ID 和响应流程。这是一种适配器候选，不是 Codex App Server wire 的另一种部署。恢复历史、重新创建 CLI 进程与连接原运行实例必须分开。[官方 SDK query 实现](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py)，[subprocess transport](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/transport/subprocess_cli.py)

Desktop 官方对照表将 scripting/automation 列为不可用，CLI 则列出 print/SDK。因此本报告结论是 **未确认可用的公开 Desktop 自动化接口**，不是断言它内部没有 IPC。Remote Control 的官方跨端连接也不证明存在供第三方使用的稳定桌面控制协议。[Desktop 对照](https://code.claude.com/docs/en/desktop)，[Remote Control](https://code.claude.com/docs/en/remote-control)

### 5.4 OpenCode：真正的共享 server 参照

OpenCode 以 HTTP OpenAPI 提供 session/message/prompt_async/abort、项目、文件、权限和事件；SSE 负责订阅。异步请求的 HTTP 成功、消息持久化及最终完成仍须区分，不能拿 204 当任务结束。普通 TUI 会启动自己的 server，单独执行 serve 不会自动接管该实例。[Server](https://opencode.ai/docs/server/)

桌面端可明确指定已有 server URL；官方给出 Desktop 连接 WSL server 的方式。适配器应复用同一 HTTP 契约，部署层处理服务发现、地址和认证。[Desktop + WSL](https://opencode.ai/docs/windows-wsl/#desktop-app--wsl-server)

SDK 由接口类型生成，可作为绑定实现。这里查到的通用 SSE 说明不足以证明永久事件重放保证，所以恢复设计仍要按能力读取权威 session/message 状态，而不是假设所有 SSE 都支持 Last-Event-ID 补齐。[SDK](https://opencode.ai/docs/sdk/)

### 5.5 其他参照只用于发现抽象缺口

- **Qwen Code**：HTTP daemon 的每个 workspace runtime 拥有独立 ACP bridge，可复用其中多个 session；不要把故障域写死成“每 session 一个进程”。SSE 支持 epoch 与有界 replay，出现缺口会要求重同步；重放窗口不是完整历史库。Desktop/WebShell 已存在，但本次没有实测其桌面附着路径。[ACP bridge](https://qwenlm.github.io/qwen-code-docs/en/developers/daemon/03-acp-bridge/)，[HTTP 协议](https://qwenlm.github.io/qwen-code-docs/en/developers/qwen-serve-protocol/)，[Desktop/WebShell](https://qwenlm.github.io/qwen-code-docs/en/blog/quickstart/web-shell-and-desktop/)
- **Qoder**：SDK 启动本地 qodercli，经 JSONL 与 control request 交互；一次字符串 query 与持续多轮 session 生命周期不同。公开 ACP 也是接入入口，但不能由此推出其 GUI 内部会话可接管。[SDK 工作方式](https://docs.qoder.com/cli/sdk/how-it-works)，[ACP](https://docs.qoder.com/cli/acp)
- **Gemini CLI / ACP**：stdio JSON-RPC，可协商会话和客户端文件/终端能力。通用层需要表达“文件操作由客户端承接”，且只能落在已授权的 Connector 主机和工作区，不能错误落到 Gateway 所在机器。[Gemini ACP](https://geminicli.com/docs/cli/acp-mode/)，[ACP v1](https://agentclientprotocol.com/protocol/v1/overview)
- **Pi**：同时有进程内 SDK 和子进程 RPC；RPC 里有 command response、session event、extension UI 等不同记录。通用层不应强制所有供应商都是 HTTP daemon，也不应把扩展 UI 一律当作权限审批。[Pi RPC](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md)

ACP 值得借鉴内容块、能力协商和请求交互，但**不适合作为本次唯一内部执行模型**：Herdr 不是 ACP agent，终端屏幕也不是 ACP transcript。未来可以增加 ACP 适配器；不应先把 Herdr 人工包装成具有不存在语义的 ACP 服务。

## 6. 建议的统一接口与职责

### 6.1 统一业务层，按真实协议实现适配器

链路保持：**IM / Web → 统一资源与交接服务 → Connector 运输 → 设备上的 Runtime Adapter → 指定运行服务**。

本次适配结构：

- 保留 Codex adapter；先迁移公共边界，再验证现有能力等价。
- Herdr TUI adapter：公共 socket、目录、输入、事件、终端读取。
- Herdr Core adapter：JSON-RPC、framed observer、终端和远端机器。
- Herdr App view client：附属于 Herdr App 接入，用于布局目录和窗口操作；不再创建第二条执行链。

Connector 的 transport、重连、来源验证不写 `if claude` / `if herdr` 聊天逻辑。设备进程可以承载不同 adapter；不能把“Connector 只负责连接”误解成它不能承载协议转换模块。

另外要分开 **运行提供者** 与 **终端中实际运行的 agent**。一个 Herdr runtime 可以同时承载 Codex、Claude、OpenCode 等程序；识别到 pane 里是 Claude，不授权 Bridge 改用 Claude SDK 打开另一个执行端。当前绑定仍属于原 Herdr 资源。未来若增加直接 Claude/OpenCode 接入，它们是用户明确选择的另一类入口，不是自动替代路径。

### 6.2 拆成可组合的能力，而不是一个巨大的 run() 接口

| 接口组 | 公共职责 | 必须保留的区别 |
| --- | --- | --- |
| Runtime / Connection | 身份、握手、健康、事件连接、能力 | 稳定服务身份、进程 epoch、独立/子进程生命周期 |
| Catalog | 主机、项目/space/workspace、session/terminal 列举与绑定 | 原生目录、推导目录、历史目录；空项目、部分不可达 |
| Submission | 提交输入、读取提交证据 | 原生消息提交、steer、原生 queue、terminal paste/keys 是不同操作 |
| Observation | 状态、增量、快照、断线重同步 | transcript event / terminal repaint / status hint，不互相伪造 |
| Interaction | 权限、问答、外部认证、人工关注 | 可答复请求有 ID/options；attention hint 可能没有答复接口 |
| Conversation | 原生聊天历史、原生轮次和设置 | 仅提供者实际支持时开放；不得从 terminal_id 合成 native turn |
| Terminal | 屏幕、终端输入、interrupt、attach/detach | 强杀与中断分离；观察不改变尺寸焦点 |
| Workspace / Artifact | 附件、文件、IDE、授权根 | 文件实际主机、上传后路径、附件内容能力独立 |
| View | 聚焦、排列、App 目录补充 | UI 操作不能替代执行协议或扩大用户权限 |

上述是接口职责分组，不意味着新增九个独立服务或要求所有 provider 实现所有组。

### 6.3 身份与回执

资源引用至少包含 connector/node、runtime、origin machine、resource kind、native resource ID；可附带原生 conversation/execution ID。资源的进程替换代次与服务重启 epoch 另行记录。

名字、窗口焦点、cwd、PID 均不能单独作为唯一绑定身份。尤其不能向“当前焦点 pane”发送群消息：用户切换窗口后会把输入发错任务。

提交结果建议分两个维度：

- outcome：明确拒绝、已确认、结果未知。
- confirmation：Bridge 已持久保存、运输对端接收、终端输入队列接纳、PTY 已写入、原生 agent 接收。它们是证据类型，不要求每种协议都按同一条链出现。

执行关联另记：精确原生 execution ID，或基于 terminal 状态计数的观察关联，或无法确认。Bridge 可以创建自己的 delivery/observation ID，但不能把它冒充 Herdr 的原生 turn ID。

Bridge operationId 解决自身重复回调/重连重入；只有上游明确提供幂等键或接收查询，才可能进一步确认输入是否已接收。**未知结果不自动再次 paste，不换一个执行器重试。** 这会保留少量需要核对的未知状态，但不能用丢弃消息或重复执行掩盖不确定性。

### 6.4 状态、事件与审批

状态分别表达：

- 连接：在线、断线、正在同步。
- 运行资源：存在、已退出、替换、未知。
- 任务：工作、等待用户、观察到结束、明确失败、无法确认。
- 结果：待生成展示、待投递、已投递、回执未知。

事件信封应包含 contract version、来源 runtime/resource、epoch、可用时的 sequence、native reference、事件类型、证据来源和完整性。terminal snapshot、append、replace 不能使用同一个“文本 delta”含义；断线时不能把最后一个 working 永久续写，也不能立即标 completed。

审批保留原 request ID、可选项、作用范围、过期/撤销和 native confirmation。另一客户端答复后要撤销当前卡。Herdr 仅报告 blocked 时，显示需要人工操作的原因和可用入口；未获得结构化请求前不提供伪造的“批准”按钮，更不能自动输入 y/Enter。

### 6.5 能力需要说明保证

boolean 仍可用于简单特性；关键能力应有带类型的描述，例如：

- history：structured messages / terminal scrollback / current screen；完整、截断或未知。
- input：native message / steer / queue / paste / keys；是否有幂等键、接收查询、目标代次保护。
- events：实时流 / bounded replay / snapshot resync；序列属于哪个 epoch。
- approval：structured decision / structured form / attention only。
- lifecycle：外部独立 runtime / Connector 子进程 / in-process；重连、恢复历史、重启程序分别支持什么。

能力由实际服务握手、版本化 schema 和适配器实现共同确定。不能只凭产品名宣称全部支持，也不能用关闭现有 Codex 功能来规避新适配。

## 7. 对当前功能的具体影响

| 既有要求 | 新适配必须保持的行为 |
| --- | --- |
| /sessions | 以所选 Connector/runtime 的原生目录组织；保留空项目和远端节点；不可达标明不完整，不误报空列表 |
| 切换 Connector / 换绑 | 原输入与回执留在原 binding generation；迟到的回调不能写入新资源 |
| 审批 @ 人、批准后新卡 | 只对真实可答复请求应用审批流程；确认后延续同一任务，不启动第二个任务 |
| 普通消息 steer、显式 queue | Codex 保持原义；Herdr 没有原生 steer/queue 保证时，展示终端输入语义或明确不支持该操作，不能偷偷变成本地持久任务队列 |
| /model 等设置 | 原生支持就设置并读取确认；不保存每轮强制覆盖。Herdr 本身没有通用模型设置时，不能悄悄另启 Codex/Claude SDK |
| 阶段成果 + 固定实时窗口 | 共享现有展示组件；终端重绘只更新实时窗口，阶段总结标明来自观察；不能每次重绘复制一份“成果” |
| AI 卡完成态 | 原生任务结束、终端状态结束、结果投递完成分别核对；无终态证据不假装成功；保留状态未知的解释 |
| 复制框与 IDE | 有效操作仍保留独立复制控件；IDE 固定链接由 Gateway 提供，不能因 adapter 切换遗漏 |
| 附件 | 先授权并存到实际目标机器，再按 native content 或路径输入能力提交；“文件已上传”不等于“模型支持读图” |
| 重启门禁 | 保护 Gateway 自身未完成的交接与投递；等待独立 Herdr/Codex 执行不锁重启；断开观察不杀进程 |
| 谁提供 session 谁审批使用准入 | 保留设备、资源所有者、聊天和操作者的授权链；知道 pane ID 不产生操作权限 |

Herdr 管理的终端集合不等于机器上所有 Claude/Codex 历史 session。若未来还要显示这些产品的未运行历史，需要明确增加对应 catalog 能力/入口；不能静默扫描另一产品私有目录，再声称都是 Herdr 原生列表。

## 8. 版本、迁移与实施顺序

现有 `src/runtime/versions.ts` 已区分产品版本、peer/execution/nativeAdapter/log 契约。沿用这一制度，增加 adapter provider、上游版本、协议 generation、schema fingerprint、已协商能力和 runtime identity。npm 产品版本不能替代上游协议版本。

建议按以下顺序实施：

1. 把本报告确定的身份、回执和事件语义写成有校验的公共合同及测试夹具；先保留现有 Codex wire compatibility。
2. 把现有 Codex facade 收进 adapter，迁移 Connector 注册、execution 请求和交互 schema。新增接口破坏旧解释时提升 execution major；运输不变不必机械地提升所有 major。
3. 新增 Herdr TUI 与 core 两个协议客户端及 App view client，采用固定配置的入口；不做断线自动切换。
4. 对照既有历史功能完成目录、输入、观察、交互、附件、IDE、卡片全链路映射；明确上游没有的保证。
5. 在隔离环境运行下节场景，再验证本地/远端、TUI/App、Gateway/Connector 分别重启。测试过的矩阵才能标为支持版本。
6. 完成旧绑定迁移、版本混跑与回滚后再发布。旧 Codex 绑定不能仅凭名字/cwd 自动改绑 Herdr；不能在迁移时重发历史输入。

现有功能文档此时只添加“调研/提案”入口，不把待开发内容改写为已实现。开发时再同步功能合同、模块文档、注释和可运行 case。

## 9. 必须补的验证场景

以下是根据本 session 历史故障与本次协议差异提出的 **待开发验收清单**。当前没有新增测试实现，也没有将它们登记为通过。

| 编号 | 场景 | 必须断言 |
| --- | --- | --- |
| HR-01 | TUI 与 core 同机同时存在，pane 内运行不同 agent | 通过配置连接正确协议；不因探测失败或识别到 agent 名称改用另一个后台/SDK |
| HR-02 | 两台机器都有 t1 / w1:p1 | catalog、输入、审批、IDE 均不串机器 |
| HR-03 | 空项目、远端掉线、finished 过滤、分页 | 保留空项目；不完整不报“没有 session”；编号稳定 |
| HR-04 | App 窗口关闭，core 仍运行 | 执行观察继续；仅窗口操作不可用 |
| HR-05 | 新建 core terminal | 执行创建与 App 布局归属分别确认；失败不重复启动 |
| HR-06 | 用户切换焦点、重命名 pane | 原绑定仍指向原资源，不跟着焦点移动 |
| HR-07 | pane 关闭后同名替换、kept terminal 重建 | 旧输入和旧停止动作不落到新进程；需要明确重新关联 |
| HR-08 | TUI agent.prompt 文本/Enter 写入边界断线 | 不把未知回执标成未提交，不自动再次 paste |
| HR-09 | core send started=false / null | 均不自动重发；准确显示确认层次 |
| HR-10 | prompt 等待超时但后台继续 | 不报告未提交或取消；继续只读核对 |
| HR-11 | agent 已 blocked 时收到普通群消息 | 不走低层输入绕过 blocked 保护 |
| HR-12 | 两客户端同时输入 | 保留各自来源与结果；不能把一次状态切换当作两条输入的精确完成回执 |
| HR-13 | 原生可答复审批在另一个客户端完成 | 撤销旧卡，迟到答复不作用于下一请求 |
| HR-14 | 仅有 blocked/permission 状态提示 | 不生成假的可审批请求，不自动按键 |
| HR-15 | interrupt 返回 still_working/unknown | 不报已停止，不升级成 kill；detach 不中断 |
| HR-16 | Gateway 重启，独立 runtime 正在执行 | 只重新观察；任务和输入数量不变化 |
| HR-17 | Connector 断线、原服务关闭、服务 epoch 变化 | 三种情况分别处理；不自动创建替代执行器 |
| HR-18 | core planned restart / server.stop / 真实进程丢失 | 保活、停止、fresh shell 三种结果不混淆 |
| HR-19 | TUI events_lost；core missed snapshot | 清理陈旧观察并重同步，不重复执行、不重复发成果 |
| HR-20 | 快照与事件交错、重复、乱序 | 不覆盖更新状态；不能简单重放到 snapshot 上 |
| HR-21 | 慢终端观察者、流控、重连 repaint | 不阻塞执行；不把整屏 repaint 追加成聊天刷屏 |
| HR-22 | observer attach 与用户 resize/focus 并行 | Bridge 不抢尺寸/焦点；正确处理尺寸更新 |
| HR-23 | 全屏程序历史读取 | 后台采样不滚动用户界面；不完整输出如实标记 |
| HR-24 | working→blocked→working→done，进程持续存活 | 不把 blocked/进程存活当作任务完成/未完成的充分条件 |
| HR-25 | 任务完成但最终卡发送失败 | 执行状态已结束；只补投递，不重跑任务 |
| HR-26 | 阶段成果、实时窗口、超长续卡 | 保留成果与 IDE/复制控件；终态后移除不适用的停止入口 |
| HR-27 | 本地/远端图片与文件上传 | 路径、所有者、大小和模型内容能力分别核验；上传不自动执行 |
| HR-28 | 换绑/撤权发生在异步准备后、原生写入前 | 写前重新核验；旧回调不能影响新绑定 |
| HR-29 | 设置模型后用户在原生 UI 再修改 | 后续输入继承原生最新值，Bridge 不覆盖 |
| HR-30 | 不支持的 queue/goal/审批功能 | 明确能力边界；不伪造成功，不暗建第二套执行状态 |
| HR-31 | 新旧 Connector、旧 binding、上游 schema 变化 | 兼容握手、可诊断拒绝、回滚；不静默截字段 |
| HR-32 | App 布局 CAS 冲突、窗口控制超时 | 不覆盖他人的布局；未知结果先读取核对，不重复创建 |

四层检查的落点：

- 架构：资源身份、事实来源、两种后台、观察与执行生命周期、授权边界。
- 模块：每条入口的准备→提交→确认→观察→投递→恢复；能力变化和跨端并发。
- 文件与函数：逐项记录实际 adapter codec、schema、错误分类、等待和恢复函数的读审范围；反例必须能击中错误实现。
- 静态文件与配置：运行入口、协议版本、模板、默认值、启动方式、服务退出语义、使用文档、旧配置迁移。

已有测试需要继续运行，但不能替代这些新的协议场景；本报告没有把“有文档”计作“已通过四层验收”。

## 10. 复核入口

### Agent Bridge

- `src/codex/backend.ts`：身份、回执、能力、runner、controls、queue 与恢复接口。
- `src/codex/interactions.ts`、`src/codex/approval.ts`：原请求与答复类型。
- `src/peer/backend.ts`、`src/peer/execution-service.ts`、`src/peer/registry.ts`：跨设备 facade、wire schema、能力注册。
- `src/peer/identity.ts`、`src/bridge/session-execution.ts`：来源操作标识与绑定写前核验。
- `src/runtime/versions.ts`：产品与独立契约版本。
- [原生协议模块](modules/native-protocol.md)、[Peer 接口矩阵](modules/peer-interface-matrix.md)、[目录历史](modules/catalog-history.md)、[原生交互](modules/native-interactions.md)、[版本架构](version-contracts.md)。
- `test/peer-complete-contract.test.ts`、`test/backend-transport-contract.test.ts`、`test/restart-handoff-boundaries.test.ts`、`test/native-settings-integration.test.ts`：已有契约与回归入口，本轮未执行这些运行测试。

### Herdr 固定源码

- [TUI schema](https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/src/api/schema.rs)、[Agent 类型](https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/src/api/schema/agents.rs)、[等待逻辑](https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/src/api/wait.rs)、[PTY 写入完成边界](https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/src/pty/actor/unix.rs)。
- [core OpenRPC](https://github.com/herdrdev/herdr-core/blob/c6b316f87c33e6f2ab1a1ceea3e3461e2b6bb61a/schema/hc.openrpc.json)、[方法表](https://github.com/herdrdev/herdr-core/blob/c6b316f87c33e6f2ab1a1ceea3e3461e2b6bb61a/crates/herdr-core/src/api.rs)、[终端事实](https://github.com/herdrdev/herdr-core/blob/c6b316f87c33e6f2ab1a1ceea3e3461e2b6bb61a/crates/herdr-core/src/terminals.rs)。
- [App 窗口控制](https://github.com/herdrdev/herdr-app/blob/cfcf836404f932817f10f88455c33e33c94fd1df/src/control.rs)、[core client](https://github.com/herdrdev/herdr-app/blob/cfcf836404f932817f10f88455c33e33c94fd1df/src/hc.rs)、[布局模型](https://github.com/herdrdev/herdr-app/blob/cfcf836404f932817f10f88455c33e33c94fd1df/src/mirror.rs)、[布局同步](https://github.com/herdrdev/herdr-app/blob/cfcf836404f932817f10f88455c33e33c94fd1df/src/mirror_sync.rs)。

下一阶段实现范围：公共合同重构、保持现有 Codex 行为、Herdr TUI/Core/App view 适配、上述验收。Claude/OpenCode/其他 adapter 不在本次实现清单中。
