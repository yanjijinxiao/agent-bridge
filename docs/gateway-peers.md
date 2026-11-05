# Gateway 的监听端、拨号端与远程 Codex

目录选择：`/connect` 展示本人当前聊天的设备，点击切换或 `/connect use C2` 保存当前 Connector，后续 `/sessions` 和 `/project` 默认只查它，重启后仍保留。切换目录不换绑、不停止原任务；选中会话才换绑。`/sessions all` 显式聚合，`/sessions --host ...` 为临时查询。离线/撤权不自动回退；新建不能沿用其他设备目录。接口和状态边界见 [当前 Connector](architecture/modules/connector-selection.md)。

本功能由管理员显式启用：未设置 `CODEX_IM_GATEWAY_PEER_CONFIG` 时不启动 Peer 监听，也不改变原有机器人后端。多人共享与共享工作区仍需按实际部署完成独立验收。第一次使用探探可先阅读 [Connector 与使用教程](tantan-connector-guide.md)；本文主要说明通用部署和接口。

服务器 A 运行 Gateway 和机器人，设备 B 主动连接 A。先配对设备，再在钉钉中查看、选择和切换 B 的 Codex 会话。本机配置无需填写 session ID，服务器按需向客户端查询会话目录。B 无需开放入站端口，A 无需 SSH 登录 B；双方需要网络互通。

流程简化（2026-11-04）：`/access` 管理本人/当前聊天的准入，个人准入同时用于 IDE，不重复登记；`/connect 配对码` 经设备确认后立即显示该设备的项目与会话，不再要求补发 `/sessions`。配对不执行或自动选择任务。IDE 默认采用个人浏览器确认，管理员也可显式开启持链接直接进入；后者目前每个账号只有一个固定授权来源，仍需具有目标设备权限，不能视为新用户自动获得自己机器的 IDE。详见 [Web IDE 访问模式](web-ide.md)。

已有单一 HTTPS 前端的部署可使用 `scripts/peer-ide-tls-front.mjs`：Peer WebSocket 转到 loopback 19478，IDE HTTP/WS 转到 loopback 28480，保留 Host/Origin/Cookie 供原授权模块验证，不发布 `/api` 管理面。端口和证书目录可通过脚本列出的环境变量配置；Gateway IDE 配置的 publicOrigin 必须与外部固定入口一致。

消息路径：钉钉 → 服务器 A 的 ChannelAdapter / BridgeService → PeerConnection → 设备 B 的 PeerExecutionService → 同一套 Codex App Server 适配器。WSS 由 B 主动建立，回复沿该连接返回。

监听和拨号属于传输角色，两端都能发起请求、接收请求和返回事件。代码放在同一个项目，分别由 `GatewayPeerServer` 和 `GatewayPeerClient` 建立连接。机器人适配器、远端执行器和远端对话适配器复用现有业务边界，不另写一套会话管理。

连接探探固定入口时，新版 Connector 已内置该入口的公开 CA，peer-client.json 可以省略 caFile，也无需下载证书文件。其他 Gateway 保持默认 TLS 信任；私有证书可显式设置 caFile，显式配置优先，不能用错误证书触发自动回退。证书链、有效期和服务器地址仍会校验。

## 1. 准备两端

两台设备都使用这个分支并执行：

```sh
npm ci
npm run build:bridge
```

B 需能以当前系统用户正常运行本地 Codex。设备配对成功后直接显示该设备已有会话，按标题、目录和编号选择即可。CLI 与 App 均使用项目统一的原生 App Server 适配器（`CodexBackendRouter` 为兼容名称）；本功能不把远程进程注入一个正在运行的交互式 CLI 终端。A 的远程设备列表查询和执行转发不依赖 A 上安装 Codex。

如果目标来自 App，需要 B 上已有的 Desktop 适配支持、相同用户和正确的 `CODEX_HOME`。已在 macOS Codex App/独立 app-server 与 Linux 容器 Gateway 之间完成设备配对、会话选择、文字往返和文件收发联调；其他系统、版本和真实审批仍需分别验证。

## 2. 设备凭据与服务器入口

管理员显式开启自助登记后，新设备不需要管理员发放 token 文件。Connector 在本机生成并保存随机身份，Gateway 在已准入用户的 /connect 和设备确认都通过后保存凭据摘要。尚未配对的连接只能完成登记，不能发布可用 host 或替换已有设备。

旧 devices/tokenFile 配置继续兼容，不改变原 hostId、授权和回执。新设备不要配置 nodeId/tokenFile；新设备凭据保存在 stateDir/device-identity.json。Gateway 的已登记设备摘要位于 Peer 配置文件旁的 .devices.json；更新时两端状态均须保留。自助登记默认关闭，以下模板明确开启。关闭 enrollment 后已登记设备仍可重连。

以 `examples/peer-server.json` 为模板创建 A 的配置：

```json
{
  "listen": {
    "host": "127.0.0.1",
    "port": 9478,
    "enrollment": true,
    "devices": []
  }
}
```

启动 A 的 Gateway：

```sh
CODEX_IM_GATEWAY_PEER_CONFIG=/absolute/path/peer-server.json npm run dev
```

或构建后使用同一环境变量启动 `node dist/server/index.js`。机器人仍在现有 Web 管理页面配置，聊天用户/群仍需加入现有准入名单。

默认监听回环地址。跨机器可选择以下一种方式：

- 使用现有 HTTPS 反向代理将 `/gateway/v1/peer` 转发到 `http://127.0.0.1:9478`，保留 Upgrade、Connection、Authorization、X-Gateway-Peer-Id、X-Gateway-Peer-Enroll 头，允许长连接和至少 60 秒的空闲时间。B 使用代理的 `wss://` 地址。
- A 直接提供 TLS：设置 `host: "0.0.0.0"` 并添加 `"tls": { "keyFile": "./server.key", "certFile": "./server.crt" }`。B 的地址须匹配证书 SAN；内部 CA 可在 B 配置 `caFile`，不会跳过证书验证。
- 仅在受控内网临时测试：A 设置 `host: "0.0.0.0", allowInsecureLan: true`，B 同样设置 `allowInsecureLan: true` 并使用 `ws://服务器IP:9478/gateway/v1/peer`。此模式明文传输凭据和内容。

不要通过这条代理公开原有 `8787` 管理接口；Peer 是单独的认证入口。服务器只有 IP 时，也可以使用包含该 IP SAN 的内部 CA 证书，或选用上述明确开启的内网测试模式。

## 3. 本机主动连接与聊天绑定

B 按 `examples/peer-client.json` 创建配置：

```json
{
  "url": "wss://gateway.example.com/gateway/v1/peer",
  "label": "我的笔记本",
  "profileId": "work",
  "backend": "app-server",
  "appServerTransport": "daemon"
}
```

`label` 是钉钉显示的设备名；新配置的设备身份由程序生成。旧配置的 `nodeId` 与 A 的设备记录一致，必须和 `tokenFile` 一同保留。`profileId` 是连接资源的标识，不等同于 Codex CLI 的 `-p` 配置 profile。可选 `codexHome`、`codexBin` 指定本地安装和资源目录；各路径相对配置文件解析，`codexBin` 按普通可执行命令解析。`stateDir` 可指定本机配对和回执目录，请保持稳定且不要由多个客户端进程同时写入。

Gateway 和 Connector 均沿用主分支统一的原生 App Server 适配器。Connector 的 `backend` 只接受 `app-server`；旧的 `exec` 配置需迁移。`appServerTransport` 默认 `daemon`，连接本机原生 daemon，不隐式回退到另一执行器。显式选择 `stdio` 可运行 CLI 私有 App Server，但任务属于该 Connector 进程，不能获得独立执行的重启豁免。

默认开放该本地 Codex profile 的普通会话供获准的聊天用户选择。若只想开放某一个会话，可显式添加 `threadId`；这种受限配置仍按原流程直接绑定指定会话。

```sh
npm run peer -- --config /absolute/path/peer-client.json
# 开发时也可使用 npm run peer:dev -- --config /absolute/path/peer-client.json
```

配对流程：

1. B 主动连接 A，终端显示类似 `A1B2C3-D4E5F6` 的设备配对码，5 分钟有效；这时无需选定会话。
2. 钉钉私聊机器人发送 `/connect A1B2C3-D4E5F6`；群里则先 @机器人再发送此命令。
3. B 终端显示申请人、机器人账号、聊天 ID，以及“允许列出、选择并操作此 profile 普通会话”的范围。核对后输入 `yes`，这是设备访问授权。
4. 钉钉确认配对后直接显示当前设备的标题、工作目录、状态和 R 编号，点击选择按钮或发送 `/session R2` 绑定；以后仍可发送 `/sessions` 或 `/sessions --host 主机ID` 刷新。若 Connector 固定到某个未归档会话，仍直接绑定该指定会话。
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

**群聊绑定是一份共享状态。** 已获准的普通 participant 可以解绑或切换到自己有权访问的会话，并不要求原绑定者同意；原任务不会因此停止，也不转移原设备权限。资源共享访客另有进入/退出已授权资源的绑定路径。需要每个人互不影响时，使用私聊或不同专用群；当前没有首次绑定者独占锁。

若希望由会话所有者批准别人访问指定 session，可使用 [会话所有权与共享工作区](peer-sharing.md)。这种资源授权不要求访问者取得整个 profile 的设备授权；Peer 的共享 Web 编辑器也按 owner 确认的目录和只读/读写能力分别校验。

`/leave` 只解除聊天的当前绑定，不撤销历史设备授权。若需撤销访问，先停止相应 B 客户端并移除本机授权记录；可停止客户端后删除其状态目录中的 `grants.json`，保留 `receipts.json` 防止历史消息重复执行。撤销整个设备时先停止该 Connector：旧静态设备从 A 的 listen.devices 删除；自助登记设备从 Peer 配置旁的 .devices.json 删除对应记录。修改前备份，随后重启监听入口以断开已有连接。删除设备凭据不等于撤销个人 IM 准入；若不允许重新登记，还需撤销该用户的登记资格或关闭 enrollment。这版尚无细粒度撤销 UI。

### 权限展示范围

`/connect` 只列当前机器人账号、当前用户、当前聊天精确匹配的设备授权，不列所有在线 Connector。首次配对前显示配对指引；Connector 终端显示带配对码的完整命令，用户发给机器人并在设备端确认后才建立授权。授权表示可访问设备，不代表设备所有权。换聊天不会自动继承设备配对。

`/access` 查询本人在当前聊天的 IM 准入来源及个人 Web IDE 配对资格；普通用户只看本人的当前聊天申请，准入管理员可处理当前聊天的申请。管理员需在机器人私聊显式发送 `/access all` 才查看本渠道全部申请；此视图生成的详情、决定和卡片操作带 `--all`，不能转发到群里使用。查看本身不登记新申请、不授予权限、不重放原消息。

Gateway 本机管理 UI 保留管理员控制台边界；它没有按钉钉用户隔离的多用户门户。项目 Web IDE 与共享编辑器使用各自的浏览器/项目授权，不因 IM 查询范围变化而改变已有权限。

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

Farming、其他 Agent 和第三方 IM 可在上述层增加适配器。传输层不理解第三方 SDK，执行层继续使用统一后端接口。会话附件和显式启用的完整 Web IDE 已接入；仅有文本共享授权的访客继续使用受限文本页，不获得终端。

### 协议 v1

固定路径 `/gateway/v1/peer`，原生客户端在 Upgrade 时发送 `X-Gateway-Peer-Id` 和 `Authorization: Bearer <设备令牌>`。新设备自动生成凭据，并额外发送 X-Gateway-Peer-Enroll: 1。只有监听端显式启用 enrollment 才接受未知设备的受限配对连接；已知设备凭据不符不能退回自助登记。配对经 IM 准入、本机确认和持久化成功后才开放目录、执行与 IDE。Gateway 保存凭据摘要，Connector 本机保存原凭据。带浏览器 Origin 的直连被拒绝；当前协议不接受浏览器 cookie 作为授权。

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

Codex 公共 facade 端口按 [接口表](architecture/modules/peer-interface-matrix.md) 适配，包含队列、恢复、Skills/MCP、精确中断、goal、独立交互、动态工具及显式原生设置。写入需要 `writeGuard: 1`；扩展原生端口需要 `nativeContract: 1`。不支持的原生能力或越出资源范围的调用明确拒绝，不改用 Gateway 本机。原生目录只在获准后查询。
### 本机项目与会话管理

两端更新后，注册信息通过 `management: { version: 1 }` 声明能力。除上述执行方法外，允许 `createThread`、`renameThread`、`archiveThread`、`unarchiveThread`，以及仅限已归档会话的 `deleteThread`；聊天中不开放永久删除命令。`listProjects` 从获准设备读取原生项目目录，Gateway 不检查远端路径在服务器上是否存在。旧 Connector 的管理请求会明确提示升级。

```text
/project                      查看本机原生项目及 C 编号
/new C1                       在选中项目新建原生空会话并绑定
/new                          在当前项目新建
/new --standalone             在当前设备的私有目录新建无项目会话
```

项目查询只提供目录和选择能力，项目新增、重命名、删除仍不在本次范围内。创建采用原生 `thread/start`，不会发送 `turn/start`，下一条消息才启动任务，也不会覆盖设备的默认模型。项目工作目录必须匹配设备端确认的项目根目录，或同项目现有会话的工作树；`/new --standalone` 的工作区放在 `stateDir/workspaces/`；完整设备授权的原生创建接口也可显式选择设备上的已有目录，固定会话或资源委托不能扩大到其他目录。未绑定时若只有一个已配对设备，可直接新建该设备的独立会话；多个设备时要求先选择来源。

通用 `/session rename|archive|restore`、`/sessions archived` 已拆到独立后续分支，本分支不新增这些聊天命令。管理端口仍供授权调用方使用，固定会话授权只允许操作该 thread。`/leave` 继续只解除聊天绑定。原生空线程在首条输入前可能尚未物化，适配器保留其订阅；不承诺在首次输入前重启仍可恢复该空线程。
每次管理写入都使用稳定源消息身份并持久记录意图、原生创建 ID 和结果。断线后状态不明的写入不自动重放，可刷新会话目录核对；重复的已完成操作返回原结果。管理与文件能力均不扩大既有用户、聊天和设备授权。

项目创建接入复用原生精确 ID；目录的通用别名展示调整已拆分，不在本分支改变本地和 SSH 目录。

### 会话附件传输

两端均需更新到包含文件传输的版本。注册信息中的 `files: { version: 1 }` 声明能力；缺失 writeGuard 的旧 Connector 不允许写入；缺失文件能力时尝试传文件明确提示更新，不会把设备路径当作 Gateway 本地路径读取。

- 入站：复用渠道下载和附件校验，再以 256 KiB 分块传给 B。上传必须有当前聊天用户身份，并匹配其设备授权和所选 thread。B 自行决定存储位置：`stateDir/files/inbound/<授权>/<thread摘要>/<会话摘要>/`，文件名带 SHA-256，重复传输复用已核对内容。完成前只写私有 `.part` 文件。
- 出站：模型继续使用 `codex-im-gateway-actions` 的 `send` 动作。B 只允许读取所选会话真实工作目录内、或该授权和 thread 的入站附件目录内的普通文件。解析真实路径，拒绝指向目录外的符号链接、相对路径及特殊文件；不允许读取其他聊天的附件。生成在临时目录等其他位置的文件，需先保存到会话工作目录再发送。
- Gateway 收到完整文件并核对 SHA-256 后，才交给原有渠道 `sendMedia`；发送完成或失败均清理 Gateway 临时副本。传输期间切换或退出绑定，则不向旧聊天发送文件。文件输出沿用既有结果动作回执，未知渠道投递不自动重复。
- 单文件上限取 Gateway `maxInboundBytes` 和 100 MiB 中较小值；仍遵守渠道本身的限制。每个 Connector 最多 8 个活跃传输、合计 200 MiB 声明大小，每个传输最长 5 分钟。单帧仍为 1 MiB。校验失败、过期或连接关闭会释放文件描述符并清理未完成上传。
- 断线后重新上传从头开始，按内容去重复用完整文件；尚无跨连接断点续传。已完成附件保留，供本机会话继续使用。传输不替代本机 Codex 的沙箱和审批，也不提供公网下载 URL。
- 能否发送图片、视频或文件由渠道能力决定。例如当前钉钉适配器支持出站文件，图片和视频的原生发送能力仍受其适配状态限制。

## 5. 可靠性与范围

- A 复用现有 `ForwardingInbox`、输入回执、权限、绑定和回复投递。B 在调用 Codex 前持久记录提交意图，在原生接受后持久记录 turn ID；重复的稳定源消息不会启动第二次执行。
- 崩溃恢复保留既有 `peer-` 原生输入编号，按原机器人账号、聊天和用户的授权重新读取所选设备历史，再复用主分支的完整分页、精确 ID 和唯一轮次校验。只有确认接受后才持久化 Gateway 回执并补投结果；身份缺失、权限已撤销或历史不完整时保持未确认，不借用其他用户的授权，也不重发输入。
- 已知未提交的离线错误按现有逻辑保留和重试。发送后状态不明、或原生已接受的输入不自动重发。重连恢复的是连接，不能宣称任意故障下“恰好一次执行”。可用 `/inbox`、`/history` 核对结果。
- 独立 app-server daemon / Desktop 的执行可以在 Gateway 观察连接断开后继续；Gateway 仅在其接受回执持久化后允许安全分离观察。显式 `stdio` 连接属于客户端进程生命周期，不获得这一豁免。
- 默认沿用 B 的模型、effort、认证和本地资源配置。A 的全局模型默认值不覆盖它；聊天中显式设置的 `/model` 或 `/effort` 仍会传给 B。
- 每个客户端连接一个本地 Codex profile，支持选择、创建、重命名、归档和恢复普通会话，可选固定到单个 thread。主要验证 macOS/Linux 的绝对路径；不附着任意终端进程。
- 原生队列、目标、容量/系统恢复、Skills/MCP、精确中断、独立交互、动态工具和结构化输出已接入公共端口；见接口表与逐项测试。项目增删改和 Taskboard 产品入口不由 Connector 自动新增。完整 code-server 需按下节显式启用。
- 显式 nativeSettings 限获准设备用户；资源委托沿用原生权限。所有文件路径属于设备，不读取 Gateway 同名文件。
- Web 管理的远程发送入口仍需用户级 Peer 授权接入；当前产品使用已有 IM 渠道。双向远端 Channel 保留独立原型，不属于此次机器人 Connector 合入范围。

## 6. 验证

当前接口、范围与结果见 [合入记录](peer-merge-readiness.md)。以下为早期版本的历史验证，不代表当前分支仍包含其中的通用会话管理命令。

```sh
npm run typecheck
node --test --test-timeout=20000 --import tsx test/peer-transport.test.ts test/peer-execution.test.ts test/peer-bridge.test.ts test/peer-files.test.ts test/peer-management.test.ts
```

这些自动化测试实际建立回环 WebSocket，经过真实 RPC、注册、配对、BridgeService、授权、持久回执和文件分块传输，Codex 使用模拟后端。

2026-10-30 的实机联调使用 macOS Codex App/0.163.0 daemon、远端 Linux 容器 Gateway 和钉钉测试机器人：附件进入本机后读出了预设标识；同一文件通过输出动作回传，钉钉中出现文件消息及确认回复。传输内部执行 SHA-256 校验。DWS 的消息查询未返回该机器人文件的资源 ID，因此尚未通过 DWS 再次下载钉钉端文件进行独立校验。真实审批、其他平台和故障注入仍不在这次实机验证范围内。

同日管理联调验证了本机项目目录、原生空会话创建（创建后 0 个模型轮次）、重命名、归档、按 R 编号恢复，以及恢复后继续同一原生会话并收到固定回复。另通过 `/new --standalone` 在 Mac Connector 私有目录新建并自动绑定了无项目会话。项目身份映射修复有独立回归，在项目中新建会话并自动绑定的完整路径另由真实 WebSocket + 模拟后端集成测试覆盖。

共享准入只决定谁能访问哪个原生会话；操作权限复用现有 `/role`，不另设 `read / chat / control` 分档。文件回传与 Web 编辑器仍单独授权。升级时旧分档委托必须重新批准，Gateway 与 Connector 需配套升级，详见[会话所有权与共享工作区](./peer-sharing.md)。

Connector导出的项目ID使用设备当前host/home的明确Desktop迁移映射，与原生session归属一致；这一适配只在Connector进程内启用，本地及SSH列表保持main行为。

## 完整 Web IDE

Connector 配置可增加 `webIDE`：`enabled` 默认 false；`binary` 默认 code-server，亦可选择本机已安装的绝对路径；`autoInstall` 默认 false，设为 true 时按固定官方版本、长度和 SHA256 安装到本用户目录。设备需要可用 Git 和终端 shell；Linux 需满足官方 code-server 的 glibc 条件。配置后重启 Connector，独立 daemon 上已接收的 Codex 任务继续。

Gateway 的 IDE 页面启用该 peer 主机，并使用可访问的共享 HTTPS 入口。无需为 Connector 开放 SSH、code-server TCP 端口或另一套密码。在所选原生项目发送 /ide；浏览器按账号配置使用个人确认或显式链接直达，最长 90 天，不自动续期。链接直达授权来源必须有目标设备的有效非委托授权；新用户配对后仍需单独核对，不能复用别人设备的权限。仅 ide-read/ide-write 的共享访客继续使用文本页，不能获得 Git/终端。

完整 IDE 具有运行 Connector 用户的系统权限；项目根不是系统沙箱。已有本人设备授权在显式启用 webIDE 后可用该能力，新增配对的本机确认会明确显示终端权限。Gateway/Connector 重连会重建 IDE 流和实例，保留 profile、文件和有效浏览器登录，但不保证终端任务存活；不会借此重发 Codex 输入。

安装和准备在同一浏览器页面显示进度，失败停止自动重试。实际验证边界、环境及未测组合见 `audits/2026-11-04-connector-ide/README.md`。
