# Connector 本机会话目录排查

## 现场证据与边界

用户提供的四张截图分别展示探探目录、CLI 的 resume 列表、Desktop 侧栏及目录警告。探探只返回 ag_machine2 上的三条远端会话；同一 Connector 的本地分支失败。Gateway 在 2026-11-06 08:12 UTC 附近记录 `native-failed`，远端仍在线。不能把三个结果解释为分页、没有本地会话或完整目录。

现场 Connector 在另一位用户的 Mac 上。当前尚未取得该设备的原始错误；下列代码缺陷的复现不等于已经证明它们是该设备本次失败的全部原因。

## 按四层检查

1. 架构：设备连接身份不等于执行主机身份。原生服务独立于 Connector；读取已有服务不应先依赖另一个 CLI 启动命令成功。保留本地/远端独立失败与相同 host/thread 身份。
2. 模块：本地 transport.prepare 无条件 daemon start，而远端直接连接现有 socket；Peer 错误边界隐藏了启动和原生 RPC 失败的阶段；远端子主机继承设备标签，误显示成 Mac 本机。
3. 函数与异常：检查 resolveLocalAppServerTransport、runCodexDaemonCommand、listThreadsByPersistence、PeerExecutionService.attach、PeerRegistry.label、handleSessionCatalog。socket 不存在、残留、权限错误、请求拒绝、不同 provider、多页与部分主机失败分别验证。
4. 静态文件与配置：检查 Connector 的 daemon 默认值、codexHome/codexBin 说明、目录模块文档、功能清单及回归夹具。不能把改为 stdio 或启动第二个执行器作为目录失败的自动回退。

## 验证记录

- 本机直接只读连接已有原生 socket，listSessionCatalog 返回 complete=true、31 条会话；没有提交或停止任务。这不是知游 Mac 的验收结果。
- 本机 Codex 0.164.0 导出的 ThreadListParams schema 明确规定 modelProviders=[] 包含所有 provider；sourceKinds 仅选择普通来源，继续隔离子任务。
- 旧 HEAD 0ff7dbf 在隔离快照运行首批 5 个新反例：5 失败。包括已有 socket 被失败的启动命令挡住、缺失命令/启动拒绝无安全阶段、旧 provider 漏项、原生错误被抹平。旧快照仅复制新增测试及错误类型定义，未替换生产实现。
- 修复后 197 项相关回归全部通过；新增 7 个 CAT-01.7 场景。第二轮补测暴露了长临时 socket 路径和假残留文件夹具的问题：缺失路径先 lstat、残留夹具改用真正的 Unix socket；旧警告断言更新为明确的部分结果语义后重跑通过。
- 新版本直接连接本机真实服务，配置一个不存在的 CLI 路径，仍返回 31 条；serverIdentity 前后均为 PID 23722。这验证复用连接，不证明报告设备已恢复。
- 原始测试日志在 /private/tmp/gateway-catalog-regression-20261106.log，精确结果在本审计同名目录 test-results.jsonl；旧版反例在 /private/tmp/gateway-catalog-before-20261106/results.log。
- 知游 Mac：尚无远程管理通道或本机具体错误，需更新该设备 Connector 后复验。本次不能报告该设备的本地会话已经恢复，也不把 Gateway 侧更新当作客户端生效。

## 发布与现场核对

代码 4b36d3b 已推送 main，头头及探探 Gateway 均返回相同版本。头头 PID 18208、探探 PID 120704，账号运行中；绑定和准入摘要、既有浏览器 IDE 授权均保留，头头本地及远端 IDE ready。本人 Mac 上两个分别连接头头/探探的 Connector 已更新至独立 runtime-catalog-20261106 目录，原配置及设备授权保持；没有启动已停用的 Linux Connector，也未操作知游设备。

更新 Connector 后再次使用相同生产适配器只读核验：原生 PID 仍为 23722，本地目录 31 条；Gateway 的项目接口返回 7 项，包含本机和原远端主机。探探的知游 Mac 连接在线，只能证明通道存在，不能证明其旧客户端本地目录已恢复。

首次发布的人工打包清单错误地将 sourceHash 写成 40 位 Git tree ID，build-info 校验要求 64 位 SHA-256，因此版本核验失败。两边先回滚旧制品；头头回滚 bootstrap 遇到旧服务尚未退出的时序问题，随后正常启动恢复。修正清单并用生产 readBuildInfo 离线校验后再发布成功。此失误与用户本机会话故障分开记录，不计入原始故障根因。成功制品与核验文件位于 /private/tmp/gateway-catalog-release2-20261106，首次失败证据保留在相邻的 gateway-catalog-release-20261106 目录。
