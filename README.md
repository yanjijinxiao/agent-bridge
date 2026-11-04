<h1 align="center">Codex IM Gateway</h1>

<p align="center">
  <img src="src/web/favicon.svg" alt="Codex IM Gateway logo" width="128" height="128" />
</p>

<p align="center">
  <strong>中文</strong> | <a href="./README.en.md">English</a>
</p>

<p align="center">
  <strong>通过个人微信、企业微信、飞书和钉钉使用本机或远程 OpenAI Codex。</strong>
</p>

`codex-im-gateway` 把即时通信消息转发给选定设备上的 Codex，并将进展、审批和结果送回原聊天。桌面和纯 CLI 环境统一使用标准 Codex App Server 接口；设备可通过本机连接、SSH 或主动拨号的 Connector 接入。

| 执行位置 | 接入方式 |
| --- | --- |
| Gateway 所在电脑 | 连接该电脑已配置的原生 App Server |
| 已登记的 SSH 主机 | 沿用主机标识及 SSH 配置 |
| 用户自己的电脑或服务器 | Connector 主动连接 Gateway，配对后在 IM 中选择会话；设备无需开放入站端口 |

Gateway 本机管理页监听 `127.0.0.1`，不作为多人登录门户。Connector 的 WSS 入口和项目 Web IDE 的 HTTPS 入口由管理员单独启用；不要公开整个管理端口。渠道配置和转发状态保存在 Gateway，原生会话、模型凭据和 Connector 配对回执保存在相应设备。

## 从哪里开始

| 你的目标 | 阅读入口 |
| --- | --- |
| 使用别人提供的 Gateway，把自己的电脑接进去 | 下方「连接已有 Gateway」，以及 [Connector 连接指南](./docs/gateway-peers.md) |
| 在钉钉使用探探 | [探探 Connector 与使用教程](./docs/tantan-connector-guide.md)，包含配对、命令、群聊和管理员开通条件 |
| 自己部署机器人和 Gateway | 下方「部署自己的 Gateway」及 [渠道配置](./docs/channel-setup.md) |
| 开通浏览器编辑、Git 和终端 | [Web IDE 配置与访问模式](./docs/web-ide.md) |
| 查看架构、功能要求和验证范围 | [架构文档](./docs/architecture/README.md) 与 [需求及 case 核对表](./docs/architecture/gateway-case-coverage.md) |

### 运行中消息与原生队列

普通消息在已确认运行中的 session 默认使用 `steer`（介入当前轮次），空闲时仍作为新一轮消息发送。全局 `activeMessagePolicy` 默认值为 `steer`，管理页可修改；已有 `/policy ask|steer|queue` 会话级设置保持不变。`ask` 仅作为兼容选项，不再是默认值。

- `/queue <内容>`：提交到 Codex 原生队列；`/queue list` 查看本聊天回执；`/queue cancel <队列ID>` 取消自己的待执行消息，controller 可取消本聊天其他用户的待执行消息。
- 队列内容、顺序和待执行项的持久化由 Codex 管理。Gateway 的 `runtime/native-submissions.json` 仅保存来源账号、用户、会话及提交/执行 ID，不保存第二份待执行 prompt。
- Gateway 重启后查询原生队列与分页历史，通过 `clientUserMessageId` / turn ID 核对。回执丢失或查不到项不会触发重发：队列项可能已经开始执行；无法确认时显示 `uncertain`。
- Codex 可能自动消费原生队列。Gateway 会保持执行连接、进展与审批订阅，并观察同一 turn，不再次启动。只有确认项仍在原生队首、会话不忙且没有 Desktop 持有者时才调用 `thread/queue/start`，不会跳过其他写入者的队列项。审批、回答和停止命令不等待队列任务。
- 重启后恢复的是原生待执行项及回执；关闭私有 stdio 执行器会中断它正在执行的任务，不能承诺该任务跨进程继续运行。恢复时会按原 turn 状态报告，不重跑已消费的输入。共享 daemon 的执行生命周期由 daemon 管理。
- 排队消息固定归属提交时的 host/backend/thread，切换绑定不迁移旧消息；旧任务完成后不会把回答送到新绑定。队列任务继承 Codex 原生会话的执行设置，不支持按队列项单独设置模型或 QA 动态工具。

原生队列是 App Server 的实验性接口；版本不支持时明确报告，不切换后端。普通运行中输入与显式 `/steer` 均使用带 `expectedTurnId` 的标准 `turn/steer`；原生回执必须确认实际接收轮次。首次创建 thread 和 QA 动态工具会话不支持原生排队。

## 核心能力

- **多渠道统一接入**：个人微信、企业微信、飞书和钉钉可以同时连接，同一套项目、会话、审批和通知能力按账号隔离运行。
- **一套 Codex 原生接口**：桌面 App、Gateway 与 CLI 客户端连接选定主机的同一个 App Server；覆盖新建、继续、跟随、交互和远端任务，断连不切换执行器。
- **Connector 设备接入**：每台设备使用独立凭据，设备端确认具体用户和聊天的访问申请；配对后可在 IM 中选择原生项目、会话及收发附件。
- **项目与 Session 管理**：从 Codex Desktop 项目注册表和 Codex 会话数据发现本机或远程项目，支持绑定、切换、新建、继续、归档状态检查和任务排队。
- **长任务持续运行**：已接受的 Agent 任务没有固定总时长上限；渠道端会持续显示可读进度、工具状态和累计用时，最终答案保持完整。
- **媒体、审批与通知**：按渠道能力处理图片、语音、视频和文件；Codex 的命令、文件修改及额外权限审批会回到原账号和原会话。
- **本机管理与扩展**：Web 页面集中管理渠道、项目、Session、模型和通知；内置 Taskboard，并允许已安装 Skill 通过声明式能力接入渠道工作台。
- **可选完整 Web IDE**：项目可使用 code-server 文件编辑、Git 和终端；支持本机、SSH 和显式启用的 Connector，访问条件和多用户限制见下文。

## 渠道支持

四种渠道共享相同的项目和 Session 生命周期；原生交互根据各平台能力实现。

| 渠道 | 接入方式 | 输入与交互 | 渠道特性 |
| --- | --- | --- | --- |
| 个人微信 | 扫码登录 / iLink | 文本、图片、语音、视频、文件 | 语音转写、原生媒体收发、输入状态 |
| 企业微信 | 官方智能机器人长连接 | 文本和机器人消息 | 无需公网回调、审批与任务通知 |
| 飞书 | 企业自建应用长连接 | 文本、菜单、消息卡片、按钮和表单 | 原生项目/任务工作台、卡片原位更新 |
| 钉钉 | 企业内部应用 Stream 模式 | 文本、图片、富文本和 AI Card | 思考状态、流式卡片原位更新、发送文件 |

平台能力和配置步骤可能随官方接口变化，详见[消息渠道配置](./docs/channel-setup.md)。

## Web 管理页

<p align="center">
  <img src="docs/images/screenshots/web-session-management.png" alt="Codex IM Gateway Web 会话管理" width="100%" />
</p>

上图为旧版界面示意，不代表当前组件布局或能力验收。

管理页可以添加和启停渠道、授权联系人、绑定项目、查看 Session 与运行任务、继续对话，并配置模型、推理强度、过程进度和任务结束通知。

可选的「Web IDE」在项目主机按需运行 code-server；进行中的 AI 卡和最终回复均可显示同一项目入口。默认关闭，无需额外 IDE 密码，但仍需启用主机并核对原生项目及访问权限。无项目会话不自动获得项目 IDE。

浏览器访问支持两种明确的策略：默认复用个人准入，首次确认本人浏览器后自动信任有权访问的项目；管理员也可显式启用「持链接直接进入」，新浏览器无需确认码或钉钉免登，持链接者可使用文件、Git 和终端。授权最长 90 天，不因访问或重启自动续期。

**链接直达目前每个渠道账号只配置一个授权来源。** 它仍须有目标 Connector 的有效设备授权，并不等于每个新用户配对后都自动获得自己设备的免确认 IDE。多人使用需分别核对并验收；不要把本机管理页当作用户门户，也不要把完整 IDE 当作目录级操作系统沙箱。详见 [Web IDE](./docs/web-ide.md) 和 [最新链接访问合同](./docs/architecture/modules/ide-access.md)。

## 连接已有 Gateway（只安装 Connector）

使用别人提供的机器人时，不需要重新部署 Gateway 或申请机器人应用凭据。先向管理员领取独立设备 ID、设备令牌文件、匹配版本的 Connector 配置，以及需要时的 CA 证书，并开通本人的 IM 准入。不要共用设备令牌或通过群聊传递秘密凭据。

1. 设备上先准备好能正常工作的 Codex、Node.js 和 Git。纯 CLI 服务器不需要桌面 GUI。
2. 获取管理员指定版本的源码，在仓库目录执行下方安装、构建命令。
3. 将管理员给出的配置与凭据放在仓库外的私有目录。配置使用同一个明确的原生服务；推荐的 `daemon` 方式不在断连时自动换执行器。
4. 在交互式终端启动 Connector，复制终端显示的完整 `/connect 配对码` 到机器人私聊；群里需先真正 @机器人。
5. 在设备终端核对申请人、聊天和范围，确认后输入 `yes`。配对码有效期 5 分钟，一次使用后失效。
6. 配对后直接选择返回的会话，再用 `/status` 核对设备和目录。换聊天需要在新聊天完成自己的设备配对。

安装依赖：

```bash
npm ci
```

只构建 Gateway / Connector 程序：

```bash
npm run build:bridge
```

启动命令模板，需把配置路径替换为实际文件：

```bash
npm run peer -- --config /absolute/path/peer-client.json
```

设备令牌用于连接认证；配对码在 Connector 连上后产生，不是通过 HTTP/curl 自助领取设备凭据。`/connect` 只列当前用户在当前机器人、当前聊天有权使用的设备。完整配置、后台运行边界和故障排查见 [连接指南](./docs/gateway-peers.md)；首次接入探探可直接使用 [逐步教程](./docs/tantan-connector-guide.md)。

## 部署自己的 Gateway

### 环境要求

- Node.js `^22.13.0 || >=23.4.0`
- Git
- 已安装并登录 Codex CLI

```bash
npm install -g @openai/codex
```

```bash
codex --version
```

### 安装与启动

项目只通过 GitHub 分发源码，不发布 npm 包。

```bash
git clone https://github.com/yanjijinxiao/codex-im-gateway.git
```

```bash
cd codex-im-gateway
```

```bash
npm ci
```

```bash
npm run build
```

```bash
node dist/server/index.js
```

服务默认打开 [http://127.0.0.1:8787](http://127.0.0.1:8787)。`npm` 只负责安装锁定依赖和构建，不会全局安装或发布本服务。

需要同时准备内置 Taskboard、`taskctl` 和内置 Skill 时，可以运行：

```bash
npm run install:local
```

```bash
node dist/server/index.js
```

完整的后台运行、更新和停止方法见[本地运行指南](./docs/local-run.md)。

## 添加渠道并开始对话

1. 打开管理页，点击“添加渠道”。
2. 选择个人微信、企业微信、飞书或钉钉，并按页面说明完成扫码或填写应用凭据。
3. 从对应聊天端给机器人发送一条消息；如渠道需要授权，在管理页允许该联系人或会话。
4. 发送 `/sessions` 分页查看当前来源中有权访问的未归档会话，再发送 `/session R1`（或点击卡片）直接绑定，无需先选项目。Connector 用户先完成设备配对，多设备时从 `/connect` 选择来源。
5. 发送普通消息继续对话。新建会话可用 `/new`（当前项目）、`/new P2` 或 `/new C1`（指定项目），也可用 `/new --standalone`（当前设备的独立会话；先核对设备来源）。下一条消息才会启动 Codex；旧 `/project add` 保留为兼容别名。

### 多人群聊与权限

**一个群共用一份当前绑定，不按群成员分别保存，也没有首次绑定者独占锁。** 已获准成员在普通 participant 权限下即可解绑或切换；切换到自己的 Connector 会话仍需自己的设备授权。切换改变全群后续消息的去向，不会停止原会话的任务，也不会将原设备权限转交给另一个人。资源共享访客还有用于进入/退出其已授权资源的绑定路径，不能把角色当作所有者锁。

个人准入用户默认是 controller，显式个人角色优先。`/role` 查询当前聊天角色；`/access` 查询本人及当前聊天准入。准入管理员在机器人私聊显式使用 `/access all` 才查看本渠道全部申请，不能在群里使用该全局视图。各自处理私人任务宜分别私聊或使用专用群；群内已经发出的消息对群成员可见。

### 消息合并

`/prompt start` 开启文字与附件合并，`/prompt done` 一次性提交，`/prompt cancel` 取消尚未提交的内容。取消合并不停止已经运行的任务；`/prompt` 不是查看系统提示词的命令。

长期无人使用的 IM 绑定默认在 **15 天无人工消息**后核验自动解绑。网页“设置”可调整全局天数（0 为关闭），会话列表的计时器按钮可单独关闭/覆盖，并展示最后人工消息和预计到期时间。任务运行、排队、等待答题/审批或状态无法确认时保留绑定；心跳与机器人回复不续期。只解绑当前 IM 对话，不删除 session 或停止任务。旧绑定升级后享有完整宽限期，重启不重置计时。

常用命令：

| 命令 | 用途 |
| --- | --- |
| `/help` | 查看全部命令 |
| `/status` | 查看当前项目、Session、后端、模型和任务状态 |
| `/sessions` | 置顶→项目及其会话→其他会话；保留空项目，默认每页 10 项 |
| `/sessions size 50` | 每页项数设为 50（支持 5-50，按聊天和用户保存） |
| `/sessions detail R1` | 查看标题、主机、目录和 ID，不切换会话 |
| `/sessions more` | 下一页（prev 上一页，page 3 跳页） |
| `/sessions search 关键词` | 按标题、内容、目录或 ID 搜索 |
| `/sessions unbound` | 只看无项目 Session |
| `/sessions project` | 只看当前项目 Session |
| `/session R1` | 绑定并继续指定 Session |
| `/session 会话ID` | 不经过列表直接绑定（远程附加 --host 主机ID） |
| `/project` | 可选：查看项目，选择时自动绑定并切换 |
| `/project C1` | 选择未绑定项目（也兼容 /project add C1） |
| `/project P1` | 切换已绑定项目 |
| `/new` | 在当前项目新建 Session |
| `/new P2` | 在指定项目新建并切换；也支持 C编号或完整项目名 |
| `/new --standalone` | 在当前设备新建独立会话；先核对设备来源 |
| `/session new ...` | /new ... 的别名 |
| `/model` | 查看或切换模型 |
| `/effort` | 查看或切换推理强度 |
| `/stream` | 设置过程进度 |
| `/follow` | 查看跟随开关、同步健康、最后同步时间及失败原因 |
| `/follow on` | 开启并立即同步；已经开启时也会重新同步 |
| `/follow sync` | 只同步当前绑定，不新建、介入或停止任务 |
| `/stop` | 中断当前任务 |
| `/connect` | 查看自己在当前聊天已授权的设备 |
| `/access` | 查看本人及当前聊天准入 |
| `/ide` | 获取已启用的当前项目 IDE 入口 |
| `/unbind` | 解绑当前聊天，不停止原任务 |

普通消息在任务运行中默认安全 `steer`，也可显式 `/queue` 或用 `/policy queue` 排到下一轮。所有操作都使用选定主机的原生 App Server，读取失败或回执不明不会切换执行器或重发。`/leave` 会持续退出绑定，直到显式选择会话或 `/new`。`/stream off` 关闭过程进度但保留最终结果。全部命令及兼容别名见[渠道命令审计](./docs/channel-command-audit.md)。

Gateway 重启后会自动恢复已有绑定及跟随游标，并在渠道支持持久句柄时续用原进度卡片；即使进展内容没有变化，也会恢复活动卡片。需要手动恢复时，在原对话发送 `/follow sync`；若跟随已经关闭，发送 `/follow on`。`/status` 和 `/follow` 区分“设置开启”和“同步成功”。超时、未确认的 Desktop 持有者、悬空界面轮次和卡片更新失败都会明确显示，不能据“未加载”断言任务结束。只有 CLI 的部署也使用同一 App Server 跟随接口，无需桌面 GUI。

任务完成和结果送达独立记录：执行回复与实时跟随使用同一份轮次投递记录，只有渠道确认收到最终答复后才去重。尚未送达的旧轮次保留自己的结果与卡片，不阻塞新轮次，不复用新轮次的卡片；短任务也会直接创建该轮次的原始结果卡。`/follow sync` 会显示待送达数量，错误提示不算最终答复已送达。升级时若发现旧版本错误标记的完成记录，只从已加载的后端精确核对最新轮次 ID 后恢复，不重放无法归属的旧卡片正文。

不带 `--host` 绑定已知会话 ID 时，会保留本聊天已知的原主机；如果同一个 ID 已绑定多个主机，必须明确指定 `--host`。未见过的 ID 仍默认本机。绑定和历史读取不会为了加载会话而启动或接管任务。

会话未加载或原生服务不可达时，群与 session 的绑定不会丢失；同步显示未确认状态，保留订阅。恢复只读取原 thread/turn 及回执，不为了同步启动任务。后续输入仍发往明确配置的原生服务；超时、权限错误及提交后的未知结果不授权自动重发。

远程项目复用 Codex Desktop 保存的 `hostId` 和本机 SSH 配置；网关不保存 SSH 密码或私钥内容。项目、模式和 Taskboard 的完整交互见[渠道项目工作台](./docs/channel-project-modes.md)。

会话列表也会隐藏本地用途配置中已确认的探活记录，并显示隐藏数量；不会仅凭 `READY` 标题或 CLI 来源过滤正常对话，也不会删除或归档记录。配置及恢复方式见[会话用途筛选](./docs/codex-backends.md#probe-records-versus-user-conversations)。

## Codex 后端

网关只实现一套标准 Codex App Server 接口。渠道、Web 和账号管理统一调用 `CodexAppServerGateway`；桌面 App 与 Gateway 是同一原生服务的客户端。只有 CLI 的服务器同样运行 `codex app-server`，不需要 GUI，也不缩减项目、Session、执行、历史、审批、队列、目标、动态工具等能力。

连接方式与业务实现分离。共享 daemon 的控制、元数据和历史连接指向同一原生服务；断连不切换执行器，已接收或回执不明的输入不重发。Gateway 重启后按原 thread/turn ID 重连核对。旧的 `codexExecutionOwner` 桌面/headless 选择已移除，`auto`/`exec` 旧配置在读取时迁移为 `app-server`；不更改原生会话的权限或审核设置。

桌面 App 如果仍连接私有 stdio 服务，需要先在任务空闲时重新接入共享服务；仅重启 Gateway 不能合并两个已有的执行进程。明确选择私有 stdio 的环境使用同一协议，但其进程生命周期仍归 Gateway 所有，不能保证运行中重启不影响任务。部署与接口验收见[Codex 后端架构](./docs/codex-backends.md)。

内置 Taskboard 的 AI 面板与事件自动处理也使用同一套原生适配器：嵌入服务借用 Gateway 实例，独立服务加载根构建并使用明确配置的原生连接，不再自行启动 CLI `exec`。关闭观察不会中断独立核心已经接收的任务；显式私有 stdio 的宿主生命周期限制仍然存在。执行、交互和恢复边界见 [Taskboard 原生执行说明](./docs/architecture/modules/taskboard-native-execution.md)，未验证组合见 [当前剩余清单](./docs/architecture/remaining-work.md)。

列表先按原生置顶顺序，再按项目目录顺序分组，最后列出其他会话；组内保留原生手工或最近活动顺序。翻页期间编号不变；15 分钟后或重新搜索/刷新时需重新选择。App 后端同时列出已知远程主机的可用会话，部分主机离线会给出提示。已归档、内部子任务及不可用会话不混入普通列表。

## 长任务、进度与 Session 生命周期

- 独立原生核心已接受的 Agent 任务继续执行，Gateway 观察断连不等于任务中断，也不重发输入；总时长不靠活动续期。私有 stdio 的执行器生命周期属于宿主，不能套用独立核心的重启保证。
- 网关只展示 Codex 提供的可读 reasoning summary、commentary、工具/命令/文件状态和最近结果，不发送隐藏的原始推理。
- 同一 thread 运行中，普通 IM 消息按已保存策略处理，默认 steer；显式 queue 只用后端原生队列。Web 提交仍校验单写入者，不承诺所有入口都自动排队。不支持的能力明确拒绝。
- Session 的活跃、运行中、已归档、不存在和系统错误状态都会经过后端生命周期接口处理；已归档 Session 不出现在可恢复列表中，继续发送时会返回明确提示。
- 渠道原生进度卡原位更新；失败保留原句柄和投递事实，不自动另发文字或替代卡。没有原生进度卡能力的渠道使用合并文字；卡片或文字在发送前按渠道能力选定，卡片被拒绝也不会触发另一条投递路线。

## Codex Desktop 集成

构建并启动网关后，可从仓库根目录运行：

```bash
npm run taskboard:codex
```

该命令会以本机调试参数启动 Codex，并在原生侧边栏增加“渠道配置”和“任务面板”入口。它不会修改 Codex 应用文件；使用期间需要保持启动器终端运行。Taskboard 的安装、数据和回滚说明见[内置 Taskboard 模块](./docs/taskboard-module.md)。

## 本地数据与旧版本迁移

新安装默认使用：

`~/.codex-im-gateway/` 下的数据：

| 路径 | 内容 |
| --- | --- |
| `accounts/` | 渠道账号凭据 |
| `runtime/<account-id>/` | 授权、项目、Session 与个人知识 |
| `inbound/<account-id>/` | 入站附件 |
| `config.json` | Codex、后端和工作区配置 |
| `logs/` | 本机运行日志 |
| `taskboard/` | 内置 Taskboard 数据 |

如果新目录尚不存在，网关会依次复用已有的 `~/.codex-channel-bridge/` 或 `~/.codex-weixin/`，无需重新配置渠道。旧的 `CODEX_CHANNEL_BRIDGE_*`、`CODEX_WEIXIN_*`、请求头和 action block 也继续作为兼容接口读取。

不要提交或分享状态目录。管理 API 会隐藏渠道 Secret、Token 和 Webhook 地址。

可使用以下环境变量覆盖启动设置：

| 环境变量 | 示例值 |
| --- | --- |
| `CODEX_IM_GATEWAY_PORT` | 8787 |
| `CODEX_IM_GATEWAY_STATE_DIR` | /absolute/private/path |
| `CODEX_IM_GATEWAY_OPEN` | 0 |

## 安全边界

- Gateway 管理服务只监听本机回环地址，并校验 Host、Origin 和运行时请求令牌；单独启用的 Connector / IDE 入口不能转发整个管理面。
- Connector 设备认证、IM 准入、聊天角色和浏览器 IDE 授权分别校验。设备配对不授予 Gateway 管理权限，群绑定不代表机器权限共享。
- 渠道凭据不会返回管理页面；未知联系人或会话默认拒绝。
- 项目来自 Codex 后端发现结果，不接受聊天端任意路径注入。
- 审批编号按渠道账号、会话和原生请求隔离。已接管的本地审批通知在超时或投递失败时按既有策略选择拒绝，是否生效仍等待原生回执；缺失本地交互路由时不代答其他客户端的请求。
- 原生审批按主机、线程和原始发起关系路由。无法确定接收关系时保留原生请求并显示诊断，不猜测目的地。
- 在收到审批通知的同一聊天中发送 `/approve A1` 批准一次，或 `/reject A1` 拒绝（群内需 @机器人）。只有 controller 可以确认；不带编号仅在该聊天恰有一个待审批请求时生效。`A1` 是 Gateway 审批编号，重启后编号继续递增，旧通知不能批准新请求。
- “已提交”不等于已生效。决策等待原生 `serverRequest/resolved` 才确认请求结束；该事件不证明永久授权已保存。未知回执不自动重发，原生已处理或撤回的请求使旧通知失效。
- `danger-full-access` 会绕过 Codex 文件系统沙箱，只应在理解整机访问风险后启用。
- 多账号任务共享本机计算资源和 Codex 配额。

## 文档

- [Gateway 双向连接、远程 Codex 与钉钉配对](./docs/gateway-peers.md)
- [探探 Connector 与使用教程（可转发给新用户）](./docs/tantan-connector-guide.md)
- [Web IDE 配置、链接访问与多用户限制](./docs/web-ide.md)
- [架构与模块文档](./docs/architecture/README.md)
- [功能要求与 case 映射](./docs/architecture/gateway-case-coverage.md)
- [消息渠道与任务通知配置](./docs/channel-setup.md)
- [Codex 后端架构](./docs/codex-backends.md)
- [统一 IM 渠道接口与能力矩阵](./docs/im-channel-architecture.md)
- [渠道项目、模式与 Taskboard 工作台](./docs/channel-project-modes.md)
- [内置 Taskboard 安装、迁移与回滚](./docs/taskboard-module.md)
- [本地运行与更新](./docs/local-run.md)
- [版本变更](./CHANGELOG.md)

## 开发与验证

```bash
npm ci
```

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run build
```

## 来源与许可

项目沿革：

XavierJiezou/codex-weixin → lsiten/codex-channel-bridge → yanjijinxiao/codex-im-gateway

原作者版权声明与 [MIT License](./LICENSE) 均完整保留，更多说明见 [NOTICE](./NOTICE)。微信 iLink 接入形态参考 MIT 许可的 `Tencent/openclaw-weixin`；项目未复制 AGPL 项目源码。

本项目是非官方社区项目，与 OpenAI、腾讯、企业微信、字节跳动、飞书、阿里巴巴、钉钉及上述上游维护者不存在隶属或背书关系。
