# Connector 唯一执行入口

状态：实施中；尚未切换线上。此文先定义迁移契约，验收记录另行补充。

## 职责

Gateway 只持有渠道、准入、聊天角色、绑定、投递和原生回执；所有 Codex 调用、目录查询、附件和 IDE 后端均通过 Connector。Gateway 不创建 App Server 客户端，不启动 Codex，不在断连时退回直连、SSH 或其他设备。Connector 在工作目录所在机器连接既有 App Server；桌面和 CLI 继续使用同一套原生接口。

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

Connector 新增 `managedRoute: { hostId, grantId }`，必须使用管理员预配置的 nodeId/tokenFile，不允许 threadId 限定或自助登记冒充托管主机。个人 Connector 配置完全兼容，不需要加入 managedRoute。

`webIDE.dataRoot` 可指向旧 IDE 实例目录，保留设置、扩展与数据；执行文件选择仍在设备本地，不能由 RPC 任意指定。已有 IDE 外部 HTTPS 入口和浏览器准入不迁移。SSH 如用于加密网络隧道或旧 HTTPS 入口转发，只承担传输，不再承担 Codex/IDE 执行。

Gateway、Connector、原生 daemon 分别管理生命周期。macOS 使用独立 launchd 项；远端 Connector 在其设备运行，不能作为 Gateway 的子进程。部署先核验连接及身份，准备完整制品后重启 Gateway；不关闭 Codex Desktop，不重建 thread，不代发历史输入。`/api/connectors` 在受保护管理面列出逻辑 host、物理 Connector 和在线状态，不返回设备凭据。

## 迁移验证

`scripts/verify-connector-migration.mjs` 提供 snapshot / verify 两步，只读比较：原生 process ID、既有绑定的 thread/cwd/项目归属/persistence，以及经明确别名投影后的项目 ID 和完整根目录。原本就不可读的 thread 单独记录，不为了核验而 resume；新出现的不可读或身份变化会失败。实时状态可能随任务推进变化，不把运行中变完成误判为迁移。

2026-11-05 预切换：真实本机及远端 2 个原生核心、25 个绑定通过比较；未停止或重发任何既有任务。项目空目录、缺失挂载、多根目录和显式别名纳入比较。最终上线记录另记；预切换通过不等于已上线。

上线实测补充：托管 IDE 必须同时保留 dataRoot 和原 instance ID。个人 Connector 原有的 principal+instance 散列规则会创建新配置目录，触发扩展冷启动并丢失原外观配置；托管路由现复用 Gateway 原 instance ID，个人设备仍按 principal 隔离。peer-ide.test.ts 的三种路径同时断言这个差异。头头和探探的首次切换已核对绑定、权限、浏览器授权与入口；此配置复用修正需在最终制品中继续核验。
