# Agent Bridge 命令与业务能力契约补充设计

日期：2026-11-07。源码已实现 36 个规范命令、22 个别名的目标分类及两套 Herdr 的能力路由，尚未发布。目录、新建/命名/关闭、只读跟随、文件/IDE、Web 与 Taskboard 边界已落地；原生模型、审批、队列等没有同等合同的能力仍明确说明。具体实现和证据见 [设计](herdr-adaptation-design.md) 与 [检查清单](../audits/2026-11-07-herdr-adapters/production-checklist.md)。

本文补充 [运行接口调研](agent-runtime-interface-research-2026-11-06.md)。上篇的协议、身份、回执和事件分析仍然适用，但没有完整覆盖命令、子操作、业务工作流和交互入口，不能单独作为完整实施设计。

## 1. 结论和证据边界

**当前 `/help` 不是跨 agent 的通用能力清单。** 命令名称可以统一，操作语义、实际支持范围和所需授权不能靠名称推断。目前既有 Gateway 自身功能，也有 Codex 原生操作，还有依赖执行器的 Taskboard、QA、扩展工作流。

当前源码基线为 `37b2a2ca8b467528167bc62cd54ce3cfce8b287e`（0.5.0）。核对了命令登记、帮助和菜单生成、主路由、上下文/角色检查、相关处理函数、Taskboard 命令层及扩展声明。不是全仓重新逐行审计。

以下为改前基线的发现；当前修复状态以操作目录、表格和测试映射为准：

1. `CHANNEL_COMMAND_REGISTRY` 有 **36 个规范命令**；只有 **11 个**登记了后端能力条件。其余命令有些本来就是 Gateway 功能，有些依赖原生能力，不能把“未登记”解释成“通用”。
2. 帮助只给标记能力且其值恰好为 `false` 的命令追加限制；未知能力没有相应说明。Taskboard 启用状态单独判断。处理函数中另有权限和能力检查，帮助缺项不等于执行时完全没有检查。
3. 帮助文本的导航以及 `createMainMenuCard()` 的按钮固定生成。即使能力全部关闭，模型、推理强度等入口仍出现；正文限制也不能约束按钮。
4. `/help` 主要读取当前绑定会话的后端能力；目录命令使用用户选定的 Connector，审批和队列回执又属于原始目标。这三种目标不能用一个全局 backend capability 判定。
5. 现有命令模块内还有 Codex 类型、thread/turn、动态工具和工作模式约束。仅把 `CodexBackend` 改名、增加两个 socket client 或过滤帮助，均不能完成适配。

Herdr 判断沿用上篇固定源码：TUI 0.9.5 / `ee5bfb5`，core 0.1.18 / `c6b316f`，App 0.1.13 / `cfcf836`。这里的“未提供”指已核对公共协议中没有对应契约，不等于永远无法扩展；也不把终端里某个 agent 的功能算作 Herdr 已暴露的功能。

### 1.1 上游接口核实：哪些确实没有对应接口

2026-11-07 追加核实：读取 TUI 全部 **102 个**请求方法、core OpenRPC 全部 **32 个**方法和 App 全部 **71 个**内置界面命令；追查输入、中断、状态和布局实现，并在线复核官方 master 方法表及文档。数量对应上述固定源码快照，不冒充新取得的最新提交 SHA。未启动 Herdr 任务，本节结论是公开接口及实现审查。

判定标准是能否实现 Agent Bridge **现有命令的行为合同**，不是 Herdr 是否有同名 slash 命令。以下 **11 个命令的核心原生操作**在两套 Herdr 执行协议中没有等价结构化接口；本地记录查询等子操作仍可保留。

| 项 | Bridge 命令 | TUI 的核实结果 | App/core 的核实结果 | 结论与可行范围 |
| --- | --- | --- | --- | --- |
| H-01 | `/model`、`/effort` | 方法表没有模型列表、当前值或会话设置更新；`agent.start.args` 可传 agent 启动参数 | 没有运行中模型/effort 设置方法；`terminal.run.argv` 和 templates 可设置启动命令 | **没有统一的运行中设置接口。** 新建时传模型参数可做，但不等于修改当前会话并读取确认；需要各 agent 的额外专门适配 |
| H-02 | `/plan` | 没有原生计划模式读取/更新方法 | 没有计划模式读取/更新方法 | **没有对应接口。** 发送一段“先计划”提示或键入 CLI slash 命令不构成相同合同 |
| H-03 | `/goal` | 没有持久目标的读取、设定、暂停、恢复、完成、清除 | 没有目标生命周期方法；`doc.set` 只是通用 JSON 存储 | **没有对应接口。** 自己保存一份目标不意味着原生 agent 会继续执行它 |
| H-04 | `/balance` | 没有 agent 账号额度查询 | 没有 agent 账号额度查询 | **没有对应接口。** Agent 状态/metadata 不等于账号配额，必须另接对应账号服务 |
| H-05 | `/steer` | `agent.prompt(target,text,wait)` 写入终端，没有 expectedTurnId 和原生消息回执 | `terminal.send` 可以在 working 时发送，并有状态条件 `if`，但没有原生 execution/message ID 校验 | **支持工作中输入，不支持现有原生 steer 合同。** 接口必须如实表达终端输入，不能声称插入指定原生轮次 |
| H-06 | `/queue` | 没有用户消息原生队列的 add/list/cancel；内部发送队列及 CLI 屏幕的 queued 字样不是这些 API | 没有用户消息原生队列的 add/list/cancel；send/wait 不提供持久队列项 ID 和取消 | **没有对应接口。** 不能以 Bridge 自建执行队列或反复等待后发送冒充原生队列 |
| H-07 | `/approve`、`/reject`、`/answer`、`/skip` | 能发现 blocked；`agent.explain` 返回状态检测依据，`agent.send_keys` 可按键；没有请求 ID、答案字段 schema、答复确认方法 | Status 有 `kind=permission/question/auth` 和说明，仍没有可答复请求/选项/决策接口；`terminal.keys`、强制 send 只是输入 | **没有结构化审批/问答接口。** 人可以通过终端处理，逐 agent 的界面自动化也可另开发，但不能直接复用现有按原请求 ID 答复的流程 |

负向判断同时核对了容易误认为补充接口的入口：TUI `command.invoke` 是客户端界面命令，`plugin.action.invoke` 执行已安装插件动作；App `do` 运行其命令表或 mod 动作。它们没有自带通用 agent 模型/审批/队列合同，插件可扩展不等于已有功能。Claude manifest 中的 `model_picker_menu`、permission 规则用于检测状态，并非模型设置或审批答复实现。

证据：[TUI 完整方法表](https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/src/api/schema.rs)、[TUI agent 参数与返回类型](https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/src/api/schema/agents.rs)、[core 完整方法表与实现](https://github.com/herdrdev/herdr-core/blob/c6b316f87c33e6f2ab1a1ceea3e3461e2b6bb61a/crates/herdr-core/src/api.rs)、[core 状态字段](https://github.com/herdrdev/herdr-core/blob/c6b316f87c33e6f2ab1a1ceea3e3461e2b6bb61a/crates/herdr-core/src/status.rs)、[App 完整内置命令](https://github.com/herdrdev/herdr-app/blob/cfcf836404f932817f10f88455c33e33c94fd1df/src/commands.rs)。

### 1.2 已确认可接或部分可接的能力

| 能力/关联命令 | TUI 已有接口 | App/core 已有接口 | 明确边界 |
| --- | --- | --- | --- |
| 目录：project/sessions/session | `session.snapshot`、`workspace.list/get`、`tab.list/get`、`pane.list/get`、`agent.list/get` | `terminal.list/get`、`machine.list`；App 的 `herdr-app` 布局文档经 `doc.get` 读取 space/tab | 能显示 Herdr 管理的目录与终端；不是列举机器上每种 CLI 未运行的历史 session。空 space 必须读布局而非只扫 terminal |
| 新建：new | `workspace.create`、`tab.create`、`pane.split`、`agent.start` | `terminal.run`、`templates.list`；App `space.new`、`tab.new`、`terminal.open` | 接口存在，需选择 agent/目录并核对就绪；不要同时走 run 和 App 新建导致重复启动 |
| 普通输入：prompt done/空闲消息 | `agent.prompt`；blocked 明确拒绝 | `terminal.send`；默认拒绝 blocked，可限定 idle/working | 发送与执行开始是两种确认；PTY 写入成功不等于有原生 userMessageId；不能把原输入再发一次换取确定性 |
| 状态/进度：status/follow/stream | `agent.get/wait`、`events.subscribe`、`agent.read/pane.read` | `terminal.get/wait`、`events.subscribe`、`terminal.attach(observe)` | 有状态和终端输出，但没有完整 Codex tool/item 事件；需要适配重绘、断线快照和阶段展示 |
| 中断：stop | `agent.send_keys`/`pane.send_keys`；无同语义的专用 interrupt 方法 | **有 `terminal.interrupt`**，返回 stopped/exited/still_working/unknown；不升级为强杀 | core 可直接对接中断，TUI 需按实际 agent 约定按键并验证效果；不能把成功发送键当已停止，不能调用 server.stop 代替 |
| 回看：history | `agent.read/pane.read` 读取屏幕/滚动内容 | `terminal.read` 读取屏幕与历史行 | **有终端回看，没有结构化消息分页历史。** 屏幕重绘、截断、角色缺失使其不能等价替代现有 transcript；Bridge 可记录接入后的消息，但不能补出接入前的完整历史 |
| 文件/图片附件 | 本次公共方法表没有与 core put 等价的文件上传方法；可使用既有 Connector 文件通道 | `terminal.put` 在实际机器写文件并返回路径，单次原始数据上限 8 MB；另有 file.read/write/edit | put 不输入路径，也不保证 agent 支持读图；保持文件授权，不能从“上传成功”推断模型已读取 |

core `SendResult.turn` 是观察计数：根状态离开 working 时递增，包括 blocked/error 等原因；不是 Codex 原生轮次 ID。该计数和 `started` 信息应保留使用，但不能被描述成缺少的原生消息确认。来源：[状态实现](https://github.com/herdrdev/herdr-core/blob/c6b316f87c33e6f2ab1a1ceea3e3461e2b6bb61a/crates/herdr-core/src/status.rs)、[OpenRPC 参数与结果](https://github.com/herdrdev/herdr-core/blob/c6b316f87c33e6f2ab1a1ceea3e3461e2b6bb61a/schema/hc.openrpc.json)。

core 的模型启动参数和就绪/按键模板已有官方说明：[Agent templates](https://github.com/herdrdev/herdr-core/blob/c6b316f87c33e6f2ab1a1ceea3e3461e2b6bb61a/docs/templates.md)。App 空项目的依据见 [布局读取](https://github.com/herdrdev/herdr-app/blob/cfcf836404f932817f10f88455c33e33c94fd1df/src/mirror_sync.rs)。这些均为已找到的接口，不再列为“是否存在待确认”。这些公开接口现已接入业务层；真实与隔离验证的范围分别列于检查清单。

### 1.3 不应归罪于 Herdr 的 Gateway 功能

connect、access、role、share/join、unbind/leave、帮助、IDE 服务、缓冲和投递属于 Gateway；需要保留并接好资源身份和授权，不能因 Herdr 没有同名方法就删掉。`policy`、`intervene` 中选择 steer/queue 的分支受 H-05/H-06 限制，本地查询/取消并不因此消失。

Taskboard 的列表/数据操作是 Bridge 业务；其执行工作流和 QA 当前依赖 Codex thread、动态工具及回调。两套 Herdr API 都没有同等的工具注册/调用/结果应答接口，故**现有工作流不能直接原样运行**。可另为终端内 agent 配置工具/MCP 并实现业务适配，但这是新增工作，不是 Herdr 自带的能力，也不能笼统宣布整个 `/task` 不可用。

## 2. 全部命令逐项映射

分类说明：G = Gateway 业务；R = 需要运行资源适配；N = 需要原生强语义能力；W = 复合工作流。同一命令可有多种分类，必须继续拆子操作。下表是各命令的行为合同；已接入的操作、上游无等价强语义和部署条件由运行接口能力返回值区分。部署尚未切换，不能把源码状态当成现网状态。

| 命令 | 全部顶级别名 | 分类 | 当前实际职责 | Herdr 接入要求或缺口 |
| --- | --- | --- | --- | --- |
| `/help` | `/h` | G | 静态帮助、扩展说明、固定操作入口 | 由同一操作契约生成说明和按钮；按目标、权限、实现能力说明可用性 |
| `/status` | `/where`、`/st` | G/R | 绑定、项目、Codex runtime/model/turn 和同步状态 | 分开连接、终端、任务证据、交互、投递状态；未知模型不填 Codex 默认 |
| `/inbox` | — | G/R | 保存的交接记录；核对、重试、取消 | 保留原 runtime/resource 和确认层次；仅明确未提交才可重试，PTY 写入未知不能重放 |
| `/balance` | `/bal` | N | 当前 Codex 账号原生额度 | Herdr 管理服务没有统一 agent 账号额度；未知不显示为 0，不合并不同 agent 账号 |
| `/project` | `/projects`、`/p` | G/R | 目录、选择项目、Gateway 登记名称管理 | 适配 workspace/space、远端机器和完整性；重命名 Gateway 登记不重命名 Herdr 布局 |
| `/new` | `/n` | R/W | 创建原生空会话并绑定，下一条消息执行 | 定义新建 conversation 与 terminal 的区别；选择已有 agent 启动配置、工作目录及布局归属，不能只创建 shell 就称 AI 会话已就绪 |
| `/sessions` | `/ss` | G/R | 跨来源目录、分页、搜索、项目分组 | 保留空项目、远端节点、稳定编号；终端集合与 agent 历史会话分开，不暗扫另一产品私有目录 |
| `/session` | `/s` | G/R | 绑定原生 ID，回看并跟随；new 是兼容语法 | 绑定有类型的资源 ID 和代次；历史/观察按实际能力启动，不借绑定接管另一个执行器 |
| `/connect` | — | G/R | 设备配对、授权连接列表、目录来源选择 | 配对运输职责不变；选 Connector 不等于换绑执行资源，不能自动选择同名 pane |
| `/share` | — | G/R | 所有权确认、邀请、准入、撤权、共享文件/IDE | 授权对象由 host/thread 扩展为完整资源引用；终端拥有者和文件所在机器不能混用 |
| `/join` | — | G/R | 申请邀请资源访问及后续绑定 | 只解析邀请中的原资源及权限；不因加入群而获得该 Connector 全部资源 |
| `/history` | `/hist` | R/N | 结构化原生对话分页 | Herdr 的 screen/scrollback 不冒充消息历史；标明类型、截断和范围，不能为读历史改变终端焦点或翻页 |
| `/ide` | — | G/R | IDE 入口、身份、浏览器授权；部分共享场景为文本编辑器 | 以资源所属机器、真实根目录和授权部署 IDE；完整 IDE/文本编辑器/无入口分别报告 |
| `/access` | — | G | Gateway 个人与当前聊天准入、管理员处理 | 继续独立于 agent 工具审批；不把允许访问 Gateway 解释为允许该资源执行写操作 |
| `/follow` | — | G/R | 跟随开关、同步、主交互目标、原实例投递重试 | 接入快照和事件恢复；off/primary 与读取观察能力拆分；断开观察不杀进程 |
| `/leave` | — | G | 兼容解绑入口 | 与 unbind 相同，只解绑当前聊天，不关闭终端 |
| `/unbind` | — | G | 清除绑定、停止当前聊天跟随 | 保留原任务及交接回执；不清理其他聊天共享的观察对象 |
| `/policy` | — | G/N | 保存忙碌输入策略 ask/steer/queue | 可读取策略；每种可选值按实际能力校验，Herdr 无 native steer/queue 时不能假装保留原语义 |
| `/role` | — | G | 当前聊天 viewer/participant/controller | 角色本身不新增 native 权限；资源准入、角色及操作能力取交集 |
| `/intervene` | — | G/N | 对待确认输入选择 steer/queue/cancel | cancel 是本地处置；提交必须使用待确认记录原目标、原操作者权限和相应原生能力 |
| `/steer` | `/iv` | N | 带当前轮次保护的 Codex 原生插话 | Herdr 输入终端不等于 steer；无等价协议不得映射成 paste，也不改成 queue |
| `/queue` | — | G/N | 原生队列 add/list/cancel 及持久来源回执 | Herdr 公共协议无相同原生队列契约；保留旧回执的查看/核对，不能建立第二套执行队列代替 |
| `/model` | `/m` | N | 原生模型列表、读取和更新会话设置 | 需要当前 agent 的结构化设置接口；不能把 `/model …` 盲打进 Herdr 终端或另启 SDK |
| `/effort` | `/e` | N | 模型支持的原生推理设置 | 动态参数 schema 和作用范围，不能给所有 agent 套 Codex 枚举 |
| `/stream` | `/str` | G/R | Gateway 过程展示偏好；最终结果保留 | off/default/读取不需要原生进度接口；on 依赖可观察内容，说明是终端观察还是结构化进度 |
| `/prompt` | `/pp` | G/R | 合并消息缓冲 start/done/cancel | 缓冲与真正提交分开；done 需要输入/附件能力，cancel 不需要；未知提交保留，不能重复发送 |
| `/approve` | `/ok` | N | 答复真实原生审批并等待确认 | 仅有 Herdr blocked 状态不足以批准；没有 request ID/答案 schema 时提供人工处理入口，不发送 y/Enter |
| `/reject` | `/no` | N | 拒绝原生审批 | 同上；拒绝、跳过、停止并非同一动作，不靠终端按键猜测 |
| `/answer` | — | G/N | 待回答请求列表、文本/选项答复 | 要求真实问题 ID、字段、权限和确认；保留可核对的原请求，不把回答变成普通 prompt |
| `/skip` | — | N | 跳过原问题 | 仅当该原生请求允许跳过时提供；不能当作批准或 Ctrl-C |
| `/stop` | `/x` | R/N | 停止当前原生任务，并处理相关待交互项 | interrupt、关闭终端、杀 runtime 分开；终端中断不能只返回 interrupted/not-active，需可表达未知、仍工作等结果 |
| `/task` | `/tb` | G/W | Taskboard 数据、绑定及启动/继续工作流 | 分离看板 CRUD 与 agent 执行、工具、结果确认；不能因能输入文本就宣称整个工作流可用 |
| `/mode` | `/v`、`/view` | G/W | 项目 session/task/qa 工作模式 | 这是 Gateway 业务模式，不是原生 plan 或 agent 模式；切换前检查整条业务依赖，失败不留下半切换 |
| `/qa` | `/q` | W/N | llm-wiki、专用提示及只读动态工具 | 当前执行依赖 dynamicTools 和工具回调；需明确 Herdr 中 agent 的工具接入方案及授权，单纯 paste 提示不等价 |
| `/plan` | — | N | Codex 原生 collaboration mode 更新 | 同名 agent 计划功能也需参数/读回语义映射；没有公共设置能力就报告该操作缺口，不注入“请先计划”冒充 |
| `/goal` | — | N | 原生 thread goal 的设置、暂停、恢复、完成、清除 | Herdr 状态计数和 done 不是持久 goal；不能偷偷新增 Bridge 目标执行器 |

`/memory` 已移除，不在这 36 项中；旧命令审计文档的“保留”清单残留本次已纠正。新增原生命令入口也不能恢复已删除功能。

### 2.1 子操作必须继续拆分

| 命令组 | 必须独立描述的操作 | 关键约束 |
| --- | --- | --- |
| help/status | help 默认/all/session；状态查询与卡片上的可执行选项 | 查看状态不触发执行；帮助展示与实际执行共用可用性判断 |
| connect | list、pair、use Cn、use local | pair 会写授权和选择；use 只改目录来源；所有列表先过滤本人/当前聊天权限 |
| project | list/page/detail、select、add 兼容入口、rename、delete | 目录读与 Gateway 元数据写分开；原生项目操作不得混入同名 Gateway 命令 |
| sessions/session/new | all/host/search/page/more/prev/size/detail/unbound/project；bind；new project/standalone | size 是展示偏好；查询不换绑；new 是外部写入；`/session new` 先规范化再鉴权 |
| history/follow | history page/more；follow read/on/off/sync/primary；retry-delivery | 关闭/主目标选择、原生同步、未知投递重试需要不同能力和角色 |
| share/join/access/role | 所有权 claim、invite、requests/list、approve/revoke、browser；join；本聊天/本人/管理员 all；角色读/写 | Gateway 准入、资源准入、IDE/file 权限、原生工具审批是四条不同授权链；按当前已有规则保留权限范围 |
| ide | entry/status、identity、auth | 身份流程可以发生在尚未绑定时；是否能打开终端由 IDE 能力和目录授权决定 |
| inbox/intervene | list/detail、retry/cancel；待确认输入 cancel/steer/queue | 读取交接状态可在后端离线时进行；写入必须回到原目标；取消本地待发不等于取消已执行任务 |
| policy/queue | policy read/set ask/steer/queue；queue add/list/cancel | policy 选项不能宽于输入能力；旧队列记录即使当前换绑仍需按原目标核对 |
| model/effort/plan | settings describe/read/update；model `--id` 消歧；plan on/off/toggle | 读写分开；当前 `/model default`、`/effort default` 是读原生设置，**不是重置**；当前无参数 `/plan` 是 toggle，**不是查询** |
| stream/prompt | stream read/on/off/default；prompt start/s、done/d、cancel | 本地偏好/缓冲不能因缺少原生执行能力而整体禁用；提交时才验证内容能力 |
| approve/reject/answer/skip | 待交互项查询；按原 ID/字段答复；跳过；查询原生确认 | 目标由原请求确定，不由用户刚选择的 Connector 确定；过期/已答/改绑不能串到新任务 |
| stop | interrupt 当前任务；查询中断确认 | 不等于 terminal close/runtime stop；不能清理不属于该目标的审批；未知结果不报已停止 |
| task | list/status/page/detail；todo；new/start；comment/attach；block/review/accept/return；Issue bind；form/submit | form/submit 与文字命令共享幂等、版本和权限；一些操作会调用 workflow，需要逐节点声明执行依赖 |
| mode/qa | mode read/select session/task/qa；QA 资源核验、工具安装/发现、执行、结果回传 | 业务模块已配置不等于当前执行器能跑；缺依赖时不先写 mode/binding 再失败 |
| goal | read/set/new/form、pause/resume/complete/clear | 修改原生目标与修改 Gateway 看板状态分开；完成目标不凭屏幕 done 推断 |

以上把处理器中重要分支纳入设计，不声称已把全部参数语法迁移成可执行 schema。实施时每个分支必须登记 operation ID，遗漏分支应在契约测试中失败。

## 3. 完整契约应放在哪一层

建议调用方向：渠道文字/卡片/Web/工作流入口 → 操作解析与目标解析 → 授权及可用性判定 → Gateway 业务服务 → Connector → runtime adapter → 原生服务。

这不是新建一个可执行任意方法的总 RPC，也不是让 Connector 识别群聊命令。职责如下：

| 层 | 应拥有的事实 | 不应承担 |
| --- | --- | --- |
| 命令/操作目录 | 名称、别名、参数、读写性质、所需业务服务/能力、帮助、呈现方式 | 直接调用 Codex 或 Herdr 方法；由文案猜权限 |
| 上下文及权限服务 | 人、聊天、资源所有者、选择来源、绑定版本、操作许可 | 从 agent 名称或 cwd 推断授权 |
| Gateway 业务服务 | 绑定/准入、缓冲、交接回执、任务板、QA、投递、展示偏好 | 重建原生队列、重复持久化模型设置、猜测审批答案 |
| Connector 运输 | 认证、契约版本、请求路由、文件运输、重连 | 重新实现每种 agent 的命令和会话业务 |
| runtime adapter | 原生能力/schema、目录、操作、结果证据、观察与生命周期 | 把终端写入升级成原生 turn 确认；用另一个执行器补功能 |
| Herdr App view adapter | 空 space/布局补充、可选聚焦和界面入口 | 成为另一个任务写入通道；通过 UI 自动点击绕过原操作权限 |

### 3.1 每个操作的描述

建议建立版本化 OperationCatalog（拟议名称，不是现有模块），每项至少包含：

- 稳定 operation ID、参数 schema、别名和兼容语法；如模型参数需带明确 ID，不能持久依赖列表第几个。
- target resolver：目录来源、当前绑定、原审批请求、原交接记录、原任务板 Issue，各自独立。
- 读取/写入/提交/中断/本地状态变更等副作用类型；是否只需本地数据。
- 所需角色、资源权利、文件权利、业务服务、适配器能力、参数约束及确认保证。
- 原生事实所有者；Gateway 保存哪些意图和回执，哪些设置只能只读缓存。
- 写前核验、幂等范围、超时/断线后的确认策略、迟到结果处理、取消语义。
- 结果 schema、错误分类、说明文案、按钮/表单/复制值、版本和可追溯 case。

产品不必全部使用英文 operation 名；它们是内部合同。内部字段不能未经转换就要求用户在 IM 里回填。

### 3.2 判定不能只有 supportsX

可用性是以下事实的交集：**适配器已实现 ∩ 原生服务已提供 ∩ 目标资源适用 ∩ 参数合法 ∩ 业务模块可用 ∩ 操作者获准 ∩ 当前状态允许**。

输出至少区分：可用、缺少绑定、未配置业务模块、不受支持、权限不足、暂时离线、能力尚未确认、原目标已变化。能力未知不等于允许；离线不等于产品不支持；有权访问会话不等于有权看账号额度或使用 IDE 终端。

能力描述必须有有效范围和代次。Connector 握手、runtime 重启、资源程序替换、模型变更后使相应缓存失效。Herdr 一个 runtime 里的不同终端不能共用“某个终端支持的模型/审批/输入能力”。

帮助和按钮读取判定结果；直接输入命令、点击旧卡、Web API 和工作流也执行同一判定。**隐藏按钮不能充当授权或适配。** 外部写入前再次验证目标和权限；写入之后即使换绑，也必须保存原始回执，不能把已提交变成“未提交”而重试。

### 3.3 三类目标不能合并

举例：用户在 `/connect` 选择 Herdr 设备 B，但当前群仍绑定 Codex 设备 A；另有 A 的一个待审批请求。

- `/sessions` 看 B 的授权目录；不因为看目录改绑。
- `/model` 操作 A 的原生会话，不能按 B 的能力判定，也不能改 B 的 agent。
- `/approve A编号` 解析原请求 A 的身份、状态和权限；之后改绑不使旧审批转到新目标。
- `/queue list` 或 `/inbox` 可以展示原目标回执，但取消/重试必须解析记录自身的来源。
- `/help` 说明每类操作的目标；未绑定时仍可看连接、目录和自己的准入信息。

### 3.4 命令名称冲突与扩展

Gateway 保留 `/help`、`/model`、`/plan` 等名称。未注册名称在核对扩展清单后给简短文字提示，再按普通消息原样提交；路径、引文和正文中的斜杠直接作为普通内容。Codex 接收的是普通消息，不承诺调用 CLI 的交互命令；Herdr 仍受终端就绪检查约束。已注册命令的权限、参数或能力错误不能降级转发。具体合同见 [斜杠输入与终端帮助](slash-routing-and-runtime-help.md)。

建议未来提供显式原生命令入口（例如 `/agent command …`，**仅为待定语法**），与 Gateway 命令分离。要声明目标、参数原样传递规则、文本/键盘输入语义和权限；原生命令可能退出程序、切会话或改变权限，不能作为绕过 Gateway 控制的万能入口。无法验证安全语义的任意终端控制属于单独授权能力，不自动对普通 participant 开放。

现有 `run_skill` 扩展会拼接 `$SkillName` 后交给 Codex 执行。通用扩展必须声明需要的资源/工具/执行能力及副作用，并根据实际目标发现已安装能力。扩展加载成功不代表所选 Herdr agent 安装了该 skill；不得把 Codex skill 调用格式作为统一协议。内置保留字和别名仍不可被扩展覆盖。

## 4. 命令之外不能漏掉的功能

| 功能链 | 设计必须补齐的内容 |
| --- | --- |
| 普通消息和忙碌输入 | 空闲、工作、blocked、未知分开；支持什么输入就明确提供什么输入，不能把 paste 命名为 steer；原生强语义缺失时不擅自退化 |
| 附件和引用 | 下载、真实文件所属机器、授权根、上传回执、输入内容格式、图片/视频能力、混合缓冲；路径存在不证明 agent 读取成功 |
| 历史与目录 | native transcript、当前屏幕、滚动内容分别描述；实际运行终端与未运行的 agent 历史分开；保留空项目、跨主机和部分失败 |
| 设置 | 模型、effort、plan、sandbox、approval policy 的 schema/作用域/生效时间/读回；不引入每轮覆盖，不改动原生权限默认值来掩盖审批链路缺陷 |
| 卡片与终态 | Herdr 单卡终端窗口，超量滚动覆盖；Codex 原生保留阶段与续卡。两者均保留状态、有效停止控件和固定 IDE；断流不是任务完成，结束后移除停止入口 |
| 审批与问答 | 原参与者 @、单处主交互、多处跟随、原生确认后新卡继续原任务、外部已答后收起、私密字段；attention-only 不生成假审批 |
| 重启与恢复 | Gateway 等待独立执行不阻止重启；断开观察不停止任务；只核对回执，不重放未知输入；Herdr daemon 重启与 Gateway 重启分别验证 |
| Taskboard | CRUD、Issue 版本/幂等、执行绑定、33 种现有工作流节点及动态工具依赖逐项映射；不能用顶级 taskAvailable 覆盖所有组合 |
| QA | 知识库根目录、只读工具、动态工具/MCP 接入、结果回传和工具权限；没有工具接入不能只发送同一提示后称已支持 |
| IDE | 连接服务不等于文件主机；保持固定入口、统一授权和现有体验。Herdr terminal 不能凭 cwd 自动获得任意目录 IDE 权限 |
| 多人跨群 | 本人/当前聊天目录、资源所有者批准、viewer/participant/controller、撤权、邀请和旧卡；知道资源 ID 或共享终端不能扩大权限 |
| 配置与版本 | provider/协议/能力/业务合同/日志版本独立记录；现有 Codex 绑定显式迁移，不按名称/cwd 自动转换；不重放升级前输入 |
| 其他入口 | IM 文本、原生按钮、Web UI、HTTP、工作流、扩展共享契约；所有入口返回同样的目标、权限原因和副作用说明 |

### 4.1 持久化责任

Gateway 应保存：身份与授权关系、目录选择、资源绑定版本、消息来源及交接/投递回执、缓冲和本地展示偏好、业务工作流状态。原生设置与原生队列/目标的权威状态由原生服务持有；Gateway 可缓存带时间及来源的观察值，不能缓存成下次调用的强制覆盖。

旧 threadId 必须以 Codex 类型迁移保存；不能强行填进 Herdr terminalId。已接收及回执不明的输入保留原来源和证据。退出/解绑仅改变观察与聊天绑定，不删除原任务或原回执。

## 5. 实施范围与验收顺序

1. 先登记完整命令/子操作及普通消息、Web 和工作流入口，把当前 Codex 行为写成可执行合同；明确兼容语法，不借重构修改用户语义。
2. 抽出有类型的资源/能力/交接及操作判定，Codex adapter 接入后跑既有回归。模型设置、原生 queue/goal、审批、Taskboard、QA 不得丢失。
3. 接入 Herdr TUI、core 执行及 App 布局信息，复用 Gateway 业务层。没有上游等价契约的能力明确列为缺口，并说明需要上游扩展还是受控的 agent 专用子适配；后者必须仍指向原运行实例。
4. 每个子操作分三种验收：等价支持、有明确不同语义的操作、不受支持。不能用“所有 `/help` 都可用”包装后两种；也不能以隐藏命令代替必要功能开发。
5. 从同一契约生成默认帮助、完整参考、卡片/Web 操作。默认展示与当前目标有关的可用操作，并说明关键缺口；完整参考保留全部命令及原因。未获准资源的细节不能因“显示不可用原因”泄露。
6. 对照下节新 case 与上篇 HR-01～HR-32，再做迁移、真实重启与界面验收。本报告只调整文档，没有修改运行代码、切换服务或上线。

Claude Code、OpenCode 等未来 adapter 用于检验 settings、工具、事件和终端的差异，本次不增加它们的执行入口。识别到 Herdr 内是 Claude 不意味着可以另开 Claude SDK 继续该会话。

## 6. 必须新增的命令与业务契约 case

下列 **CC-01～CC-24 均未实施、未运行**，不计入已有通过数；与上篇 HR 场景互补。

| ID | 场景与必须断言 |
| --- | --- |
| CC-01 | 登记表、别名、全部子操作与帮助/入口双向覆盖；新增路由却无契约时报错，废弃 memory 不复活 |
| CC-02 | 全能力关闭、未知、离线、缺绑定、无权限、模块未配置分别生成帮助；区别暂时不可用与原生不支持 |
| CC-03 | 文本/原生卡片/Web/直接命令可用性一致；按钮被隐藏也不能绕过执行鉴权，旧按钮点击重新核验 |
| CC-04 | 选择 B、绑定 A、原交互 A、后来换绑 C；目录、设置、审批及回执各自落到正确目标，无串写 |
| CC-05 | 同 runtime 的 Codex/Claude/普通 shell 终端能力不同；替换 agent 或 generation 后旧能力缓存失效 |
| CC-06 | sessions 空项目、远端不可达、部分结果、稳定分页编号、重名不同主机；历史 agent 会话不混成活终端 |
| CC-07 | new 的 native conversation/terminal 区别；agent 未就绪、启动失败/未知、布局写入失败，不产生假成功或第二个终端 |
| CC-08 | bind/unbind/leave/connect use 的不同副作用；解绑不停止任务，选择目录不换绑，旧观察事件不污染新绑定 |
| CC-09 | 普通输入空闲/工作/blocked/未知与 ask/steer/queue 组合；不支持 steer 不偷偷 paste，blocked 不输入到审批框 |
| CC-10 | queue add/list/cancel 分开；切换不支持队列的 runtime 仍可查原回执，取消回原目标，不造本地执行队列 |
| CC-11 | prompt start/cancel 不需要提交能力；done 保留多条顺序、附件和原目标；超时/崩溃不重复提交 |
| CC-12 | stream off/default 可用而 on 无观察能力时受限；关闭进度仍发送结果，旧偏好不伪造能力 |
| CC-13 | 模型/effort schema、显式数字模型 ID、外部修改、设置读回、模型支持项变化；default 不被误实现成 reset |
| CC-14 | mode 与 plan 分离；plan 空参数现有 toggle 语义及控制权限保持；模式切换失败不预写错误状态 |
| CC-15 | structured history/screen/scrollback 分开；截断标注；后台查询不触发终端翻页、聚焦或改尺寸 |
| CC-16 | Herdr attention-only 不出现 approve/answer 假按钮；真实请求的过期、外部答复、选项和秘密字段按契约处理 |
| CC-17 | 原生审批确认后 @ 原人、新卡继续同任务；换绑/撤权/多群不转移审批目标，不另起任务 |
| CC-18 | stop 精确作用于原资源；不杀 runtime/关闭 terminal；未知或仍工作不报已停止，不清理其他目标交互 |
| CC-19 | Taskboard CRUD 能力独立于 workflow；各节点依赖不满足时提交前失败，form/submit 重试保持幂等和 Issue 版本 |
| CC-20 | QA 必须发现实际可调用的知识工具；提示可发送而工具不可用时不报可执行，工具访问根和只读限制不丢 |
| CC-21 | 账号额度作用域与资源只读权限分开；不向共享会话访问者泄露未授权账号用量，未获取不显示零额度 |
| CC-22 | Gateway slash、原生 slash 和 skill 扩展冲突；已注册命令优先，未知命令提示后进入普通输入权限/绑定/忙碌检查，失效卡片不转发 |
| CC-23 | 阶段卡/续卡/终态/复制框/IDE 在 TUI 与 App 观察上保持契约；重绘不刷成果、结束不留 stop、断流不报完成 |
| CC-24 | 老 Codex 配置/绑定/队列/审批记录迁移、版本混跑、Gateway/Connector 独立重启；保存原确认层次、无重复输入和隐式换执行器 |

## 7. 本轮实际验证与四层审查范围

实际验证：

- 使用当前代码生成“所有 backend capability 为 false、Taskboard 关闭”的帮助，确认 model/effort/history 等仍无能力限制说明，模型导航仍生成。这是帮助可用性表达的反例，不证明相关处理器会绕过权限执行。
- 运行 `test/channel-help.test.ts`：**3 项通过、0 失败**。这些测试覆盖登记保留字、部分能力限制、帮助格式；仍未覆盖上述反例需要的全操作判定。这解释了为什么已有帮助测试通过而设计仍缺项。
- 文档完整性检查按实际 `CHANNEL_COMMAND_REGISTRY` 对照本表：36 项命令、22 个顶级别名，无遗漏或重复；四份相关文档的 70 处本地链接目标存在。`git diff --check` 通过。这些是文档检查，不是新增运行功能的验收。
- 未运行 Herdr 真实任务、未执行 CC/HR 计划场景、未做全库回归或手机验收；未变更线上服务。

| 层 | 本轮核对范围 | 仍需实施时验证 |
| --- | --- | --- |
| 架构 | 命令/业务/运输/原生职责；三种目标；权限、设置和回执事实源 | 通用操作合同、原生能力等价性及迁移的可执行验证 |
| 模块 | help、菜单、路由、角色、模式、输入/控制、Taskboard 命令、QA、扩展的实际依赖 | 全入口统一判定和完整端到端行为 |
| 文件与函数 | 下列源码登记、条件分支和关键调用链 | 本文未声称全仓或 Taskboard 所有节点逐行审完 |
| 静态与配置 | 帮助文本/按钮、当前审计文档及设计入口、参数语义和版本信息 | 部署配置、真实 UI、各 adapter 注册和混跑校验 |

复核入口：

- `src/bridge/channel-commands.ts`：36 项登记、别名规范化、帮助静态文本及能力标注。
- `src/bridge/interaction-cards.ts`：固定主菜单与选项卡生成。
- `src/bridge/access.ts`、`src/bridge/channel-command-policy.ts`：角色、项目及工作模式条件。
- `src/bridge/service.ts`：命令路由、connect/help/stop；project/new/mode/plan/goal/history/follow/policy/queue/prompt/model/effort/stream 等处理；QA 动态工具调用。
- `src/bridge/taskboard-channel-command.ts`、`taskboard-channel-controller.ts`、`taskboard-channel-submit.ts`、`taskboard-channel-legacy.ts`：任务数据与执行工作流的交叉边界。
- `src/bridge/channel-capability.ts`、`src/bridge/skill-extension-manifest.ts`：扩展声明与 `run_skill` 路由。
- `src/codex/backend.ts`：现有 Codex 能力、状态、stop 结果、输入回执的类型限制。
- `test/channel-help.test.ts`：当前 3 项帮助测试的实际断言范围。

Herdr 与未来 agent 的原始来源、固定源码链接见上篇第 10 节；本补充没有增加未经核实的上游接口承诺。


## 2026-11-07 持续跟随实现增量

Herdr 的 `/follow on/off/sync` 已使用只读观察协调器，`/stream` 可刷新现有卡的展示开关；`primary` 显式拒绝不存在的结构化交互路由。原生 `liveFollow` 标记继续仅用于 Codex 原生事件订阅，Herdr 不伪造 turn 或 native completion。该段是持续跟随检查点；后续生命周期、完整命令路由、Web/Taskboard 与文件/IDE 结果统一见生产四层清单，不由这一项推断其他功能。

隔离覆盖两个 adapter 类型的连续外部运行、Gateway 重建、重复 sync、follow off 与输入结果独立、stream off/on 原卡及 IDE 保留；观察模块另测实例替换、撤权、丢投递和重试原终态卡。后续已补多用户、跨群、撤权、原来源重建及两套实际 Herdr 的 Connector SIGKILL 恢复。Herdr 无强轮次 ID，通知按输入来源分别保存，不猜测多人属于同一任务；真实钉钉和无序号轮询间隔内的外部任务仍有验收边界。
