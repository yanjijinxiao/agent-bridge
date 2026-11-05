# Connector 唯一执行入口

状态：Connector 唯一执行入口已在头头、探探上线。下列验证记录区分预检、已完成切换与后续兼容修正。

## 职责

Gateway 只持有渠道、准入、聊天角色、绑定、投递和原生回执；所有 Codex 调用、目录查询、附件和 IDE 后端均通过 Connector。Gateway 不创建 App Server 客户端，不启动 Codex，不在断连时退回直连、SSH 或其他设备。Connector 连接既有 App Server，并复用同一个原生后端访问其登记的远程主机；不要求每台远端再安装 Connector。桌面和 CLI 继续使用同一套原生接口。连接身份与目标主机身份分离，见 [多主机路由](connector-host-routing.md)。

Gateway 重启只断开观察连接。Connector 和已接收任务独立存活，重连后核对原生状态和回执。已接收或接收不明的输入不能自动重发。Connector 重启同样不拥有独立 Codex daemon 的生命周期。

## 迁移身份与权限

保留已有 `hostId`、thread ID、项目 ID、聊天绑定和浏览器授权作用域。部署配置将历史 host 显式映射到唯一的 Connector 节点及 profile；本机 `local` 也是逻辑身份，不再表示 Gateway 内执行。这样不批量改写回执、队列、审批、附件来源或固定 IDE URL。

原本由 Gateway 管理的本机/SSH 主机采用双方明确配置的托管路由授权。它只替换原有执行传输，不新增个人准入：现有 Gateway 准入、角色和最终写入守卫继续生效。路由仅接受预配置的设备认证身份，不能通过临时配对、设备同名或 Connector 自报 host 抢占。个人 Connector 继续按 account/conversation/actor 配对授权；托管路由不能赋予其他个人设备权限。

托管路由携带真实操作来源；后台观察使用限定于该托管路由的服务身份。文件和 IDE 仍分别核验聊天来源和浏览器主体。浏览器准入、撤销代次与有效期不变；设备侧继续核对原生项目、目录和文件范围。

## 兼容要求

1. 已有 session 继续绑定，无需用户逐个解绑；原 App Server 的原生 thread 和任务不迁移到新执行器。
2. 历史直接提交的来源 ID 和新 Connector 来源 ID 都能只读核对，不能把查询不到当成未提交而重放。
3. 原生队列已有条目的来源 ID 不得重新编码；新增条目继续持久映射。
4. 临时推理、后台恢复、审批订阅、动态工具、会话/项目目录、模型与设置都走同一个 Connector facade。
5. IDE HTTP/WS、终端、Git、多根目录和附件收发与执行走同一主机；网关不使用本机文件存在性替代远端核验。
6. `/connect` 的目录选择不改变已有绑定；历史 host 名可保留作为兼容身份，展示应明确它对应的 Connector。

## 验收清单

| 层级 | 检查和反例 |
| --- | --- |
| 架构 | Gateway 无原生执行实例；无匹配路由、离线、错误身份均不回退；重启 Gateway 不终止原生任务 |
| 模块 | 同名节点/profile、个人与托管权限隔离、角色变化、审批重连、队列回执、历史来源核对、IDE 授权与附件 |
| 函数 | 所有 facade 端口逐项核对；最终写入守卫、来源编码、逻辑/物理身份、连接关闭、迟到回调 |
| 静态和配置 | 双端严格配置、安装/启动说明、服务生命周期、迁移清单、固定链接与功能文档 |

上线前比较原/新通道的 serverIdentity、绑定会话及项目根目录；准备制品后只切换 Gateway。验收记录必须区分隔离测试、真实原生协议和线上只读核验，不能用测试总数代替迁移证明。

## 部署配置与生命周期

Gateway 的 `CODEX_IM_GATEWAY_PEER_CONFIG` 指向监听配置。原有 `listen`、`resources` 继续有效，新增 `managedRoutes` 数组，每项包含：

- `hostId`：原绑定使用的逻辑主机，如 local 或 remote-ssh-discovered:原主机；不能填 peer: 身份。
- `nodeId` / `profileId`：唯一的设备及 profile，必须与 Connector 配置一致。
- `grantId`：部署时生成的 UUID，双方匹配；它是授权关联标识，设备认证仍使用私密凭据。

Connector 使用 `managedRoute: { hostId, grantId }` 保留主入口；可用 `managedHosts` 声明同一连接承载的既有远程目标（每项含 hostId、nativeHostId、grantId，可选主机专用 webIDE 配置）。Gateway 相应 managedRoutes 保留原 hostId/grantId，将 nodeId/profileId 指向同一个 Connector，并填入 nativeHostId。一个物理连接可承载多个不同目标，重复逻辑主机或重复目标均拒绝。必须使用管理员预配置的 nodeId/tokenFile，不允许 threadId 限定或自助登记冒充托管主机。个人 Connector 配置完全兼容，不需要加入 managedRoute。

`webIDE.dataRoot` 可指向旧 IDE 实例目录，保留设置、扩展与数据；执行文件选择仍在设备本地，不能由 RPC 任意指定。已有 IDE 外部 HTTPS 入口和浏览器准入不迁移。SSH 如用于加密网络隧道或旧 HTTPS 入口转发，只承担传输，不再承担 Codex/IDE 执行。

Gateway、Connector、原生 daemon 分别管理生命周期。macOS 使用独立 launchd 项；远端 Connector 在其设备运行，不能作为 Gateway 的子进程。部署先核验连接及身份，准备完整制品后重启 Gateway；不关闭 Codex Desktop，不重建 thread，不代发历史输入。`/api/connectors` 在受保护管理面列出逻辑 host、物理 Connector 和在线状态，不返回设备凭据。

## 迁移验证

`scripts/verify-connector-migration.mjs` 提供 snapshot / verify 两步，只读比较：原生 process ID、既有绑定的 thread/cwd/项目归属/persistence，以及经明确别名投影后的项目 ID 和完整根目录。原本就不可读的 thread 单独记录，不为了核验而 resume；新出现的不可读或身份变化会失败。实时状态可能随任务推进变化，不把运行中变完成误判为迁移。

2026-11-05 预切换：真实本机及远端 2 个原生核心、25 个绑定通过比较；未停止或重发任何既有任务。项目空目录、缺失挂载、多根目录和显式别名纳入比较。最终上线记录另记；预切换通过不等于已上线。

上线实测补充：托管 IDE 必须同时保留 dataRoot 和原 instance ID。个人 Connector 原有的 principal+instance 散列规则会创建新配置目录，触发扩展冷启动并丢失原外观配置；托管路由现复用 Gateway 原 instance ID，个人设备仍按 principal 隔离。peer-ide.test.ts 的三种路径同时断言这个差异。头头和探探的首次切换已核对绑定、权限、浏览器授权与入口；此配置复用修正需在最终制品中继续核验。

托管主机保留迁移前的附件导出范围：会话输出可以位于临时目录或同机其他项目根目录，由既有 Gateway 准入、当前绑定与设备静态托管授权共同约束。个人 Connector 仍仅允许所选工作目录和已接收附件；托管身份不可借用到物理 peer ID。两者均检查会话、绝对路径、文件类型、大小、稳定性、校验和及租约；不允许符号链接末端，不允许任意上传目标。NAT-07.8 直接覆盖这些差异。

2026-11-05 首次线上切换已完成：头头与探探的 Gateway 运行 5e5ed71；头头 25 个绑定、原准入和浏览器授权保留，两个原生核心 PID 未变。托管 Connector 由独立 launchd 服务管理；远端通过独立 SSH 作业和隧道承载，不归 Gateway 进程所有。远端 SSH 客户端退出不保证服务端 Connector 已退出，升级时须核对锁对应的实际进程并仅停止该 Connector，不能删除活进程锁或停止 Codex。IDE 配置复用和临时附件兼容的最终补丁须与 Gateway/Connector 同步发布，验证结果记入部署产物。

最终兼容补丁完整回归：3293 项，3207 通过、86 条件跳过、0 失败；typecheck 与 diff 检查通过。日志 connector-unification-final-compat.log；条件跳过不计入已验收。测试使用隔离数据，不向真实 IM 发送消息。

上线性能核验发现：sessionSummary → interactionDestinations → ThreadEventHub.status 逐层重新枚举所有订阅，读取配置和克隆绑定随会话数放大，导致管理接口超时。AccountManager 现只在一次同步展示读取内复用订阅视图，finally 释放，禁止跨 await 或写入守卫保留；配置在单次订阅枚举内只读一次。NAT-07.9 用 30 个活跃绑定验证读取次数、立即换绑和异常清理，模块 78 项全通过。

多会话性能修正后完整回归：3294 项，3208 通过、86 条件跳过、0 失败；类型检查通过。该优化不修改 Connector 协议、授权或原生任务生命周期。

## 最终线上记录（2026-11-05）

头头和探探均已推送并运行代码提交 6eafcde；两个托管 Connector 运行 24ca88e（其后仅 Gateway 展示性能与文档变化，Connector 协议及执行代码未变）。头头本机/远端、探探 linux12/本机测试设备均经 Connector 路由。头头原 25 个聊天/thread 绑定和聊天准入保留，本机原生 PID 1272、远端原生 PID 171321 未变化。发布冻结已解除。

IDE 实际启动：本机双根工作区、远端单根工作区均为 running，使用已有固定入口；测试没有修改工作区信任。性能修正后，本机 Connector 状态读取约 3 ms、43 条会话目录约 38 ms（单次线上采样，不是性能保证）。最终全量回归 3294 项：3208 通过、86 条件跳过、0 失败。

授权验收边界：探探原浏览器授权完整保留；头头基线 20 条中 17 条逐条哈希一致，3 条旧记录不再存在，因此不能写成“所有浏览器授权保留”。同时发现 3 个历史 IDE 引用锁定的旧项目 ID 与当前原生归属不一致，其中一个会话在预切换快照中已归档；旧验收快照只有授权指纹与过期时间，无法逐条反推出已消失记录。当前项目固定入口已实测，浏览器授权有效期仍为 90 天、无授权文件读取错误；没有根据名称/相同目录将旧授权强行移到新项目，也没有恢复不明授权。手机端视觉与这些旧 cookie 的再次访问未实测。

本次按变更范围核对四层：Gateway 无执行核心和生命周期解耦；路由/授权/回执/项目/IDE/文件模块；最终守卫、来源 ID、实例 ID、分块文件与展示快照函数；配置、launchd、独立远端服务、静态 UI、README 和迁移案例。该记录不声称重新逐行审查未变更的全仓库，也不把条件跳过或历史 cookie 缺失算作通过。部署证据保存在本机 gateway-connector-projection-20261105 目录中，包含版本、接口延迟、IDE 状态及授权差异；凭据不进入仓库。


2026-11-05 后续修正：Linux Connector 已按用户要求关闭。新的单 Mac Connector 路由复用既有远端 App Server，不恢复 Linux Connector 或其旧隧道；旧上线记录是历史证据，不代表当前仍需两个 Connector。当前修正的验证记录见 [多主机审查](../audits/2026-11-05-connector-host-routing.md)。
