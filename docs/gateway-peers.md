# Gateway 的监听端、拨号端与远程 Codex

服务器 A 运行 Gateway 和机器人，设备 B 主动连接 A。先配对设备，再在钉钉中查看、选择和切换 B 的 Codex 会话。本机配置无需填写 session ID，服务器按需向客户端查询会话目录。B 无需开放入站端口，A 无需 SSH 登录 B；双方需要网络互通。

```text
钉钉私聊 / 群聊 @机器人
          ↕ 现有 DingTalk ChannelAdapter
服务器 A：BridgeService → withPeerBackend → PeerConnection
                                               ↕ WSS（由 B 主动发起）
设备 B：Codex CLI / App ← CodexBackendRouter ← PeerExecutionService
```

监听和拨号属于传输角色，两端都能发起请求、接收请求和返回事件。代码放在同一个项目，分别由 `GatewayPeerServer` 和 `GatewayPeerClient` 建立连接。机器人适配器、远端执行器和远端对话适配器复用现有业务边界，不另写一套会话管理。

## 1. 准备两端

两台设备都使用这个分支并执行：

```sh
npm ci
npm run build:bridge
```

B 需能以当前系统用户正常运行本地 Codex。已有会话会在设备配对后显示在钉钉中，按标题、目录和编号选择即可。CLI 与 App 继续由项目已有的本地 `CodexBackendRouter` 识别和路由；本功能不把远程进程注入一个正在运行的交互式 CLI 终端。A 的远程设备列表查询和执行转发不依赖 A 上安装 Codex。

如果目标来自 App，需要 B 上已有的 Desktop 适配支持、相同用户和正确的 `CODEX_HOME`。已在 macOS Codex App/独立 app-server 与 Linux 容器 Gateway 之间完成设备配对、会话选择、文字往返和文件收发联调；其他系统、版本和真实审批仍需分别验证。

## 2. 设备凭据与服务器入口

为每台设备生成独立的高熵令牌文件，分别放到 A、B 的配置目录，通过你已有的安全方式传递。令牌不放在 URL、聊天消息或仓库中。例如在配置目录执行：

```sh
node -e 'require("node:fs").writeFileSync("my-laptop.token", require("node:crypto").randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" })'
```

以 `examples/peer-server.json` 为模板创建 A 的配置：

```json
{
  "listen": {
    "host": "127.0.0.1",
    "port": 9478,
    "devices": [{ "nodeId": "my-laptop", "tokenFile": "./my-laptop.token" }]
  }
}
```

启动 A 的 Gateway：

```sh
CODEX_IM_GATEWAY_PEER_CONFIG=/absolute/path/peer-server.json npm run dev
```

或构建后使用同一环境变量启动 `node dist/server/index.js`。机器人仍在现有 Web 管理页面配置，聊天用户/群仍需加入现有准入名单。

默认监听回环地址。跨机器可选择以下一种方式：

- 使用现有 HTTPS 反向代理将 `/gateway/v1/peer` 转发到 `http://127.0.0.1:9478`，保留 Upgrade、Connection、Authorization、X-Gateway-Peer-Id 头，允许长连接和至少 60 秒的空闲时间。B 使用代理的 `wss://` 地址。
- A 直接提供 TLS：设置 `host: "0.0.0.0"` 并添加 `"tls": { "keyFile": "./server.key", "certFile": "./server.crt" }`。B 的地址须匹配证书 SAN；内部 CA 可在 B 配置 `caFile`，不会跳过证书验证。
- 仅在受控内网临时测试：A 设置 `host: "0.0.0.0", allowInsecureLan: true`，B 同样设置 `allowInsecureLan: true` 并使用 `ws://服务器IP:9478/gateway/v1/peer`。此模式明文传输凭据和内容。

不要通过这条代理公开原有 `8787` 管理接口；Peer 是单独的认证入口。服务器只有 IP 时，也可以使用包含该 IP SAN 的内部 CA 证书，或选用上述明确开启的内网测试模式。

## 3. 本机主动连接与聊天绑定

B 按 `examples/peer-client.json` 创建配置：

```json
{
  "url": "wss://gateway.example.com/gateway/v1/peer",
  "nodeId": "my-laptop",
  "label": "我的笔记本",
  "tokenFile": "./my-laptop.token",
  "profileId": "work",
  "backend": "app-server"
}
```

`nodeId` 与 A 的设备记录一致，`label` 是钉钉显示的设备名。`profileId` 是连接资源的标识，不等同于 Codex CLI 的 `-p` 配置 profile。可选 `codexHome`、`codexBin` 指定本地安装和资源目录；各路径相对配置文件解析，`codexBin` 按普通可执行命令解析。`stateDir` 可指定本机配对和回执目录，请保持稳定且不要由多个客户端进程同时写入。

默认开放该本地 Codex profile 的普通会话供获准的聊天用户选择。若只想开放某一个会话，可显式添加 `threadId`；这种受限配置仍按原流程直接绑定指定会话。

```sh
npm run peer -- --config /absolute/path/peer-client.json
# 开发时也可使用 npm run peer:dev -- --config /absolute/path/peer-client.json
```

配对流程：

1. B 主动连接 A，终端显示类似 `A1B2C3-D4E5F6` 的设备配对码，5 分钟有效；这时无需选定会话。
2. 钉钉私聊机器人发送 `/connect A1B2C3-D4E5F6`；群里则先 @机器人再发送此命令。
3. B 终端显示申请人、机器人账号、聊天 ID，以及“允许列出、选择并操作此 profile 普通会话”的范围。核对后输入 `yes`，这是设备访问授权。
4. 钉钉显示“我的笔记本”的会话列表，包含标题、工作目录、状态和 R 编号。点击相应选择按钮，或发送 `/session R2`；Gateway 才把当前聊天绑定到所选会话，并显示历史。
5. 后续文字消息继续所选会话。发送 `/sessions` 可刷新当前设备的列表，再通过 `/session R编号` 切换；新增的本机会话无需重启客户端即可发现。`/history` 查看历史，`/stop` 请求停止，`/leave` 退出当前聊天绑定。

例如钉钉显示：

```text
可绑定会话 · 我的笔记本
R1  排查资源问题    /Users/me/project-a
R2  开发网关        /Users/me/project-b

你：/session R2
机器人：已绑定会话：开发网关
你：继续完善设备连接功能
```

发送 `/connect` 可再次打开已配对设备的入口；选择设备后查看它的会话列表。`/sessions` 默认显示当前绑定的远程设备，或唯一已配对设备的会话；`/sessions all` 查看所有来源，`/sessions --host 主机ID` 明确指定设备。配对和查看目录不创建任务，也不会把未选择的普通消息发往 Gateway 本地执行。

配对码一次使用后即失效，即使本机拒绝也不能复用。过期或拒绝后可重启 B 客户端获取新码。客户端自动重连，已完成的授权在双方重启后仍有效，设备模式的主机 ID 按设备和 profile 保持稳定，切换会话不改变主机。首次授权需要交互式终端，非 TTY 不自动批准；之后在钉钉切换会话无需再次回本机确认。退出 B 客户端用 Ctrl-C；它不注册后台系统服务。

默认设备授权对应 **accountId + conversationId + actorId + 本地 profile**，允许该用户在这个聊天中查看目录、选择并操作普通会话。受限模式则额外固定到指定 thread。允许设备连接并不等于允许所有机器人用户操作它。群聊绑定后，其他成员仍需取得自己的本机授权（可重连生成新码，再由该成员发 `/connect`）。已有机器人准入和角色检查同时生效。

`/leave` 只解除聊天的当前绑定，不撤销历史设备授权。若需撤销访问，先停止相应 B 客户端并移除本机授权记录；可停止客户端后删除其状态目录中的 `grants.json`，保留 `receipts.json` 防止历史消息重复执行。撤销整个设备则从 A 的配置删除设备凭据并重启入口。这版尚无细粒度撤销 UI。

## 4. 标准接口与复用关系

| 层 | 接口 | 用途 |
| --- | --- | --- |
| 监听端 | `GatewayPeerServer.listen` | 校验设备身份，接受连接 |
| 拨号端 | `GatewayPeerClient.start/close` | 主动连接、心跳、自动重连 |
| 双向连接 | `PeerConnection.handle/request` | 两端对等的版本化 RPC |
| 远端执行器 | `PeerExecutionService` | 查询本机会话目录，确认设备访问授权、执行选中会话、持久回执 |
| 路由适配 | `withPeerBackend` | 将 `peer:` 主机接入现有 `CodexBridgeBackend`，其他本地/SSH 路由保留 |
| 远端对话入口/出口 | `createPeerChannelAdapter` / `attachPeerConversation` | 在连接任意一端适配现有 `ChannelAdapter`，收消息并回传回复 |

远端对话适配器目前是可嵌入 API，测试已分别接到监听端和拨号端的真实 `BridgeService`。配置文件和 CLI 首先覆盖“机器人 → 远端 Codex”的执行器场景，尚未提供对话客户端的管理 UI 或独立交互 CLI。

Farming、其他 Agent 和第三方 IM 可在上述层增加适配器。传输层不理解第三方 SDK，执行层继续使用统一后端接口。会话附件传输已接入；Web IDE、通用文件浏览和代码只读预览链接仍需独立适配。

### 协议 v1

固定路径 `/gateway/v1/peer`，原生客户端在 Upgrade 时发送 `X-Gateway-Peer-Id` 和 `Authorization: Bearer <设备令牌>`。带浏览器 Origin 的直连被拒绝；当前协议不接受浏览器 cookie 作为授权。

```json
{ "version": 1, "type": "request", "id": "请求UUID", "method": "方法名", "params": {} }
```

```json
{ "version": 1, "type": "response", "id": "原请求UUID", "result": {} }
```

失败响应以 `error: { code, message, data? }` 代替 `result`。每个方向均可主动发请求；进度、审批等回调也是有回执的请求。

| 方法 | 方向与语义 |
| --- | --- |
| `peer.register` | B → A，注册设备名、profile 和能力；可选声明固定 thread；返回 hostId、设备配对码及期限 |
| `binding.approve` | A → B，请本机确认具体用户与聊天的设备访问范围 |
| `execution.call` | A → B，携带持久授权、方法参数及写操作 operationId |
| `execution.callback` | B → A，携带 operationId 的进度、原生接受、审批、问答和写前绑定校验 |
| `conversation.input` | 远端对话端 → ChannelAdapter，文本消息与源消息 ID；身份取本地配置 |
| `conversation.output` | ChannelAdapter → 远端对话端，回复和投递回执 |
| `fileUploadBegin/Chunk/Finish` | `execution.call` 内的文件上传操作，把聊天附件分块存到获准设备的专用目录 |
| `fileDownloadBegin/Chunk` | `execution.call` 内的文件下载操作，读取所选会话目录中的输出文件 |
| `fileClose` | 释放当前连接、授权所拥有的传输；未完成的上传删除临时文件 |

连接每 15 秒 ping/pong，单帧最大 1 MiB，每方向最多 256 个在途请求。历史可分页；超限明确报错。协议版本不匹配拒绝连接，不猜测兼容字段。

Codex 执行写调用允许 `run`、`steer`、`submitThreadMessage`、`stop`；会话管理写调用见下节。只读支持 `listSessionCatalog`、inspect、snapshot、history/page、runtime、models、limits、turn lifecycle 和 receipt。目录请求通过 `execution.call` 发送，在获准配对后才查询本机，不在注册时公开全部会话。B 在执行前验证目标是本地普通会话，并核对该会话真实 cwd；受限模式额外固定 thread。不提供任意命令执行 RPC。

### 本机项目与会话管理

两端更新后，注册信息通过 `management: { version: 1 }` 声明能力。除上述执行方法外，允许 `createThread`、`renameThread`、`archiveThread`、`unarchiveThread`，以及仅限已归档会话的 `deleteThread`；聊天中不开放永久删除命令。`listProjects` 从获准设备读取原生项目目录，Gateway 不检查远端路径在服务器上是否存在。旧 Connector 的管理请求会明确提示升级。

```text
/project                      查看本机原生项目及 C 编号
/new C1                       在选中项目新建原生空会话并绑定
/new                          在当前项目新建
/new --standalone             在当前设备的私有目录新建无项目会话
/session rename 探探测试       重命名当前原生会话
/session archive              归档当前原生会话并解除当前聊天绑定
/sessions archived            查看已归档会话
/session restore R1           恢复列表中的会话并绑定
```

项目查询只提供目录和选择能力，项目新增、重命名、删除仍不在本次范围内。创建采用原生 `thread/start`，不会发送 `turn/start`，下一条消息才启动任务，也不会覆盖设备的默认模型。项目工作目录必须匹配设备端确认的项目根目录，或同项目现有会话的工作树；独立会话固定放在 `stateDir/workspaces/`，不接受 Gateway 任意指定路径。未绑定时若只有一个已配对设备，可直接新建该设备的独立会话；多个设备时要求先选择来源。

重命名、归档和恢复要求聊天 `controller` 权限；运行中、空闲状态不明或有待执行原生队列的会话不会被归档。归档遵循 Codex 原生生命周期及子会话处理规则，其他入口也会看到归档结果；它与 `/leave` 的“仅解除当前聊天绑定”不同。恢复可使用编号，或 `/session restore 会话ID --host 主机ID`，编号有效期为 15 分钟。固定会话授权只能管理该 thread，不能新建其他会话；归档后重连仍能查询并恢复它。

每次管理写入都使用稳定源消息身份并持久记录意图、原生创建 ID 和结果。断线后状态不明的写入不自动重放，可刷新会话目录核对；重复的已完成操作返回原结果。管理与文件能力均不扩大既有用户、聊天和设备授权。

App 的项目 ID 与原生 app-server 的项目 ID 可能不同。设备端按现有 App 保存的精确 host/home 映射统一目录与会话身份，再将写入转换为原生 ID；不按同名或相同目录推断项目身份。

### 会话附件传输

两端均需更新到包含文件传输的版本。注册信息中的 `files: { version: 1 }` 声明能力；旧 Connector 的文字路径继续可用，尝试传文件时明确提示更新，不会把设备路径当作 Gateway 本地路径读取。

- 入站：复用渠道下载和附件校验，再以 256 KiB 分块传给 B。上传必须有当前聊天用户身份，并匹配其设备授权和所选 thread。B 自行决定存储位置：`stateDir/files/inbound/<授权>/<thread摘要>/<会话摘要>/`，文件名带 SHA-256，重复传输复用已核对内容。完成前只写私有 `.part` 文件。
- 出站：模型继续使用 `codex-im-gateway-actions` 的 `send` 动作。B 只允许读取所选会话真实工作目录内、或该授权和 thread 的入站附件目录内的普通文件。解析真实路径，拒绝指向目录外的符号链接、相对路径及特殊文件；不允许读取其他聊天的附件。生成在临时目录等其他位置的文件，需先保存到会话工作目录再发送。
- Gateway 收到完整文件并核对 SHA-256 后，才交给原有渠道 `sendMedia`；发送完成或失败均清理 Gateway 临时副本。传输期间切换或退出绑定，则不向旧聊天发送文件。文件输出沿用既有结果动作回执，未知渠道投递不自动重复。
- 单文件上限取 Gateway `maxInboundBytes` 和 100 MiB 中较小值；仍遵守渠道本身的限制。每个 Connector 最多 8 个活跃传输、合计 200 MiB 声明大小，每个传输最长 5 分钟。单帧仍为 1 MiB。校验失败、过期或连接关闭会释放文件描述符并清理未完成上传。
- 断线后重新上传从头开始，按内容去重复用完整文件；尚无跨连接断点续传。已完成附件保留，供本机会话继续使用。传输不替代本机 Codex 的沙箱和审批，也不提供公网下载 URL。
- 能否发送图片、视频或文件由渠道能力决定。例如当前钉钉适配器支持出站文件，图片和视频的原生发送能力仍受其适配状态限制。

## 5. 可靠性与范围

- A 复用现有 `ForwardingInbox`、输入回执、权限、绑定和回复投递。B 在调用 Codex 前持久记录提交意图，在原生接受后持久记录 turn ID；重复的稳定源消息不会启动第二次执行。
- 已知未提交的离线错误按现有逻辑保留和重试。发送后状态不明、或原生已接受的输入不自动重发。重连恢复的是连接，不能宣称任意故障下“恰好一次执行”。可用 `/inbox`、`/history` 核对结果。
- 独立 app-server daemon / Desktop 的执行可以在 Gateway 观察连接断开后继续；Gateway 仅在其接受回执持久化后允许安全分离观察。`exec` 属于客户端进程生命周期，不获得这一豁免。
- 默认沿用 B 的模型、effort、认证和本地资源配置。A 的全局模型默认值不覆盖它；聊天中显式设置的 `/model` 或 `/effort` 仍会传给 B。
- 每个客户端连接一个本地 Codex profile，支持选择、创建、重命名、归档和恢复普通会话，可选固定到单个 thread。主要验证 macOS/Linux 的绝对路径；不附着任意终端进程。
- 本版本不启用动态工具、原生队列操作、目标、自动系统错误恢复和原生项目增删改。后端能力明确关闭或拒绝这些操作；不能回退到服务器本地执行。
- Web 管理的远程发送入口尚未接入用户级 Peer 授权；通过钉钉等已有渠道的 `handleMessage` 路径使用本功能。已启动任务期间的审批/问答已做回调适配；独立外部任务的审批和断线期间错过的回调还需后续补齐。

## 6. 验证

```sh
npm run typecheck
node --test --test-timeout=20000 --import tsx test/peer-transport.test.ts test/peer-execution.test.ts test/peer-bridge.test.ts test/peer-files.test.ts test/peer-management.test.ts
```

这些自动化测试实际建立回环 WebSocket，经过真实 RPC、注册、配对、BridgeService、授权、持久回执和文件分块传输，Codex 使用模拟后端。

2026-10-30 的实机联调使用 macOS Codex App/0.163.0 daemon、远端 Linux 容器 Gateway 和钉钉测试机器人：附件进入本机后读出了预设标识；同一文件通过输出动作回传，钉钉中出现文件消息及确认回复。传输内部执行 SHA-256 校验。DWS 的消息查询未返回该机器人文件的资源 ID，因此尚未通过 DWS 再次下载钉钉端文件进行独立校验。真实审批、其他平台和故障注入仍不在这次实机验证范围内。

同日管理联调验证了本机项目目录、原生空会话创建（创建后 0 个模型轮次）、重命名、归档、按 R 编号恢复，以及恢复后继续同一原生会话并收到固定回复。另通过 `/new --standalone` 在 Mac Connector 私有目录新建并自动绑定了无项目会话。项目身份映射修复有独立回归，在项目中新建会话并自动绑定的完整路径另由真实 WebSocket + 模拟后端集成测试覆盖。
