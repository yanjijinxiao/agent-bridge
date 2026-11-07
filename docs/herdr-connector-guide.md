# Herdr Connector：连接和使用

本文对应已经实现、尚未 npm 发布的 Herdr 适配。探探及 Mac/Linux12 专用 Connector 已部署验收构建；头头与已发布 npm 包不自动获得这些功能。用户处理证书提示后，Mac 与 Linux 的真实浏览器已验证文件编辑、Git、集成终端与刷新重连。Gateway 与 Connector 都需支持 `runtimeContract: 1`。产品版本、Peer 协议和 Herdr 运行接口版本分别检查，不能只看软件名称。

## 1. 连接的是哪个服务

每个 Connector 配置明确选择一个执行入口，所有渠道使用相同的授权、目录、文件和 IDE 模块。

| 配置 | 连接目标 | 必要条件 |
| --- | --- | --- |
| backend = herdr-tui | 已运行的 Herdr TUI 公共 JSONL socket | 明确选择 TUI session，不能把默认 session 当作其他命名 session |
| backend = herdr-app | Herdr App 的窗口 socket，以及该 App 使用的同一个 core socket | 固定 core 身份，窗口布局和终端记录交叉核验；不会启动第二套 core |
| backend = app-server | 既有 Codex App Server | 保持原配置和行为，不因增加 Herdr 自动迁移 |

本轮实测版本为 TUI 0.9.5、App 0.1.13、App 的 core 0.1.18。这是兼容性证据，不要求把安装命令永久锁在某个 Git commit。TUI 当前校验 0.9.x 公共响应，App 校验 core generation 1 和响应结构；其他版本仍须实际验收。

只有被选中 Herdr 服务托管的终端会进入目录。CLI 磁盘上的历史会话、另一个 TUI session、其他 core 的终端不会被猜测合并。

## 2. Connector 配置字段

沿用自己的 Connector JSON 配置和 Gateway WSS 地址。地址由 Gateway 管理员提供，不能填写 App socket、IDE HTTPS 链接或他人的设备凭据。路径填写绝对路径，不使用 `~`。

| 字段 | 填写内容 | 要求 |
| --- | --- | --- |
| url | Gateway 的 WSS Connector 地址 | 沿用现有入口及 TLS 校验 |
| label | 自己便于识别的设备名称 | 仅显示名称，不是授权依据 |
| backend | herdr-tui 或 herdr-app | 与 runtime.kind 相同 |
| runtime.version | 数字 1 | Bridge 运行配置格式版本 |
| runtime.id | 自定稳定名称 | 1–80 位字母、数字、下划线或短横线；实际身份还包含 socket 与 core 等字段 |
| runtime.kind | herdr-tui 或 herdr-app | 明确选择，不自动回退 |
| runtime.socketPath | TUI 的实际 socket 路径 | 仅 TUI；通过所选 session 的连接信息确认 |
| runtime.windowSocketPath | App 的实际窗口 socket 路径 | 仅 App |
| runtime.coreSocketPath | 当前 App 使用的 core socket 路径 | 仅 App，不要另起 core 来凑路径 |
| runtime.expectedCoreId | 该 core 的真实 core.id | 仅 App，读取其公共 hello 中的身份；不能填 PID、版本或自编名称 |
| runtime.interruptKeys | 可选对象：准确 agent 名称映射到 esc 或 ctrl+c | 仅 TUI；例如 codex 对应 esc。只发送一个明确配置的键，不支持通配符或自动尝试多个键 |
| stateDir | 可选的 Connector 私有状态目录 | 持久保存设备身份与交接回执；不要放临时目录或由多个实例共享 |
| webIDE.enabled | 是否允许自己的浏览器使用完整 IDE | 显式启用；访客文本共享不能取得终端权限 |
| webIDE.autoInstall | 是否允许安装官方 code-server 制品 | 可沿用已有安装；凭据和项目授权仍由 Gateway/Connector 检查 |

App 窗口入口常见于用户配置目录下 herdr-app/herdr-app.sock；core 使用自己的状态目录。路径可能受平台、XDG 变量和启动方式影响，必须以当前服务为准。core 身份可通过 Connector 所用同一公共 JSON-RPC `hello` 获取；它是服务标识，设备认证 token 则是秘密，二者不同。

Herdr 配置不混入 codexHome、codexBin、appServerTransport 或 managedHosts。首次配置通常省略 nodeId/tokenFile，由程序生成并保存身份；既有迁移配置的 nodeId 与 tokenFile 必须成对保留。不要把设备凭据发到群里。

启动仍使用同一个 agent-bridge-connector 程序和 `--config` 参数，指向上述 JSON 文件。启动会验证本地 Herdr，再注册 Gateway。握手失败会退出并清理本进程资源，不改接其他执行器。运行路径变化会生成不同 endpoint 身份，不沿用旧资源授权。

## 3. 配对、选择和日常使用

1. 在设备启动 Connector，按它实际显示的完整配对命令发送到目标聊天；在设备确认具体申请人和聊天。
2. 使用 `/connect` 查看自己在当前聊天可用的设备，选择这个 Connector。选择目录设备和改变既有会话绑定是两件事。
3. `/sessions` 按项目和终端展示；没有终端的项目仍保留。按实际输出选择资源进行绑定。没有可信工作目录的终端可以读、写、观察，但不能据此开放文件或 IDE。
4. 普通消息只交接给已绑定的终端。正在工作、等待终端处理或身份不明时，不把聊天文字当作审批答案强行输入；也不会建立另一条任务队列。
5. 进行中卡保留已稳定的阶段成果，当前活动限长刷新；最终卡按段落显示本次成果，不照搬输入回显、旧任务、命令全文和终端装饰。命令默认只显示条数与详情提示；当前模板尚无原生点击折叠控件，`/history` 显示当前终端快照（不是逐命令持久归档）；`/status` 显示观察状态；`/follow on/off/sync` 控制只读跟随。`/stream` 只改变展示，不改变执行状态或授权。
6. `/new` 显式填写 agent、名称和目录，实际启动新终端。TUI 名称须以小写字母开头，长度 1–32，允许字母、数字、下划线和短横线。App 的 agent 为显式程序名。具体完整格式由 `/help` 或不带参数的 `/new` 显示。
7. `/session rename 新名称` 重命名绑定资源。App 只允许独占 tab，避免连带修改其他终端；`/session close --confirm` 会结束目标终端，`/unbind` 只解绑聊天。

切换 Connector 后，可以用 `/new` 的 `--cwd` 明确指定新设备目录；上一个设备的项目不会被带过去。省略 `--cwd` 时，当前项目必须属于所选设备。重命名成功后，聊天绑定名称同步更新。

`/stop` 是请求中断。App 使用原生 terminal.interrupt；TUI 仅对匹配配置且正在工作的 agent 发单个中断键。返回“已请求”后继续观察，不能把写键成功当作已取消任务。blocked 状态不自动发送按键回答。

## 4. 文件、共享和 IDE

本机终端使用本机目录；App 远端终端从同一 core 的 machine.list 解析已连接的机器。目录、项目、endpoint、机器配置和权限变化后，旧传输或 IDE 租约不能继续套用。远端路径绝不回退为 Connector 本机同名路径。

远端文件和 IDE 需要该机器可运行 Node；SSH 连接须已配置主机密钥和非交互认证，或使用该 Herdr machine 的显式 via 命令。这里不会借用 core 内部的密码输入或私有 ControlMaster 状态。只有 core 的密码会话可连接、外部 SSH/via 不可用时，终端功能仍可使用，文件/IDE 会明确报连接问题。

code-server 复用统一安装、配置、访问控制和 socket 中继。远端 helper 使用登录账户的持久 HOME，socket 目录限本用户访问；每次新连接重新核对原资源。完整 IDE 的终端具有运行账户权限，项目列表不等于操作系统沙箱。所有者可授权文本共享；文本共享只授予选定目录读写，不包括完整 IDE 的 Git/终端。

## 5. 原生接口边界与恢复

Herdr 的终端画面不是 Codex 的原生对话。当前上游没有等价的模型/推理设置、结构化审批、原生消息队列、goal 或工具结果协议；Bridge 会说明不支持的具体操作，不输入 slash 命令或 yes 来假装实现。Taskboard 的任务 CRUD 和普通工作说明保留；依赖结构化最终答复的 AI 工作流节点、QA 明确检查所需能力。

交接回执持久化后，Gateway/Connector 的重连只读核对原来源。已写入或结果未知的输入不自动重发，持续观察不阻止 Gateway 重启；Gateway 不拥有 Herdr 任务的生命期。Herdr 自身退出、终端被用户关闭仍会影响任务。

输入参与者按原账户、聊天、用户保存；不同人的请求不猜测为同一个原生轮次。屏幕中的命令、附件动作块、审批文字都只是显示数据。idle 仅表示观察到空闲；无法据此宣称业务成功。轮询之间瞬间完成且没有变化序号的外部任务可能无法观测。

源码审查与测试记录位于仓库 docs/audits/2026-11-07-herdr-adapters；实机环境与清理记录位于 docs/architecture/herdr-test-environments.md。源码回归通过、真实 Herdr 测试、手机展示及现网发布分别记录，不互相替代。

## 容器运行与崩溃恢复

同一 Connector 状态目录必须只有一个写入进程；进程锁使用操作系统 PID 判断旧进程是否仍在。不要把该目录交给每次都在独立 PID namespace 中以 PID 1 运行的临时 Node 容器：重建后的 PID 1 会让旧锁保守地判为仍占用。容器部署应在该可信主机的稳定 PID namespace 中运行，或直接使用主机 Node；多个隔离容器不得同时共用状态目录。

本轮 Linux12 的临时 Node 包装器实际触发了该限制。专用验收 Connector 已改为共享所属开发容器的 PID namespace；先核对旧容器确已停止，再备份其精确旧锁，未清除其他实例的锁。后续 SIGKILL/restart 按真实非 1 PID 自动恢复，不再手工删锁。该部署要求不等于关闭独占保护，也不允许在无法核实旧进程时删除锁。
