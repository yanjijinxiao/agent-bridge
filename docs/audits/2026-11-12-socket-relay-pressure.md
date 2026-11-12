# 大响应导致原生 Socket 转发拥塞

## 现场证据与边界

用户截图中的开发需求在头头 forwarding-inbox 中仍保留原消息及原绑定；它经过明确的未提交失败后自动重试。Gateway 与 Mac Connector 在线，原生 thread/read 经独立只读 WebSocket 连接只需 2 ms。同一时段两个 Connector 子进程持续高 CPU，常驻内存约 1.3 GiB 和 2.3 GiB，命令确认为 APP_SERVER_SOCKET_RELAY。目标原生记录约 84 MB，本轮长会话记录约 2.7 GB；记录大小不等于单次 RPC 大小，不据此声称 API 返回了整个文件。

旧 relay 在每次 socket chunk 到达时 Buffer.concat 全部未完成帧，反复复制大响应；后续元数据超时/读取连接轮换又增加重连压力。原生服务可读不等于这条转发连接可用。另一个展示缺陷是：已知未提交的重试仍调用失败卡片终结，用户因此连续看到“执行失败”，但原生并没有接收相应任务。

## 实施前设计及四层检查

1. 架构：保持同一个原生接口、socket 和执行器；只修本机/SSH 共用的字节传输及未提交呈现。不重启原生核心，不切换执行器，不按截图中的任务文字另行执行开发、建群或提交输入。
2. 模块：socket 帧用分块队列顺序消费，头部有界、完整载荷最多复制一次；保留分帧 UTF-8、ping/pong、close 和断线行为。帧及累计消息设明确上限，不能把缺尾的大响应当作完整数据。stdout 背压暂停读取，防止慢消费者导致无限堆积。
3. 函数/代码：隔离测试在真实 Unix socket 上运行导出的 relay 脚本，记录实际复制总量而非只看耗时；用原实现复现超预算。检查协议边界、退出、清理和后续小消息。已知未提交且尚无原生 turn 的自动重试不应产生新的失败卡，已接收/未知回执仍不重发。
4. 静态/配置：同步功能 case、模块、函数、测试和本记录；无新增用户表单、权限缓存或执行分支。现场恢复与程序修改验证分开留证，不能以重启成功代替修复验证。

## 代码检查

- APP_SERVER_SOCKET_RELAY：完整检查嵌入 JS 函数和事件回调。take 消费或单次复制完整区间，peek 最多检查 14 字节；分片累计预算在取载荷前判断。stdout 背压恢复时先继续已缓存帧，再恢复 socket。错误退出不输出半条 JSONL，不发起第二份业务请求。
- BridgeService.runCodexTurn：检查本次准备/markActive/onTurnStarted/onDelta/catch 及相邻 finally。已有持久收件箱才延迟创建任务卡；明确原生接收后才产生“已接收”进展。非收件箱及显式 queue 沿用各自处理，accepted、unknown 和结果投递错误不降级为未提交。
- ForwardingInbox：ownsPendingInput 是显示归属查询；deliver 仍复核派发后的真实 journal，只有 received/automatic 和原有错误分类才退避重试。抽出的分类函数未扩大旧重试集合。AccountManager 通过同账号实例延迟查询，无新持久字段或配置。
- fs/getMetadata 的实际 0.167.2 schema 没有文件字节大小，fs/readFile 没有范围参数。本次未虚构 stat size/range 支持；既有 128 MiB 权限记录解码限制仍在，但不能在读取前通过这些接口拒绝大文件。256 MiB wire 预算是独立传输边界，超限不能截断成有效权限。

## 隔离验证和反例

- 原 HEAD 的 relay 跑新测试，在 8 MiB 分块响应上稳定触发 COPY_BUDGET_EXCEEDED；测试预算为线性字节数，不依靠机器速度判断。反例记录：/private/tmp/agent-bridge-socket-relay-before.tap。
- 修复后 8/84 MiB、分片 UTF-8、控制帧、长度 125/126/65535/65536、超限帧/累计消息、半包关闭 10 项；与未修改的 Desktop owner 23 项合跑，33/33 通过。记录：/private/tmp/agent-bridge-relay-pressure-and-owner.tap。
- Bridge/Inbox/原生输入生命周期等首次针对性组合 100/100 通过（当时大帧仅 8 MiB）；包含真实落盘、两次准备失败后一次接收、单条通知、无失败卡及接收后答案增量。不能把这个旧计数写成最终源码的全量结果。
- 首次全量 3878 项中 3776 通过、101 跳过、1 项失败：未修改的 Desktop owner 延迟负发现测试在受载机器超出 120 ms 预算。原断言未放宽，在上述 33 项组合中复核通过。一次未提权的复核因 sandbox 禁止 Unix socket 而失败，该次不算产品验证。
- 最终全量 3879 项：3778 通过、101 依既有 opt-in 条件跳过、0 失败；隔离编译成功。日志：/private/tmp/agent-bridge-relay-final-full-20261112.tap 和 agent-bridge-relay-compile.log。
- 真实原生相邻回归 13/13 通过，使用独立临时 Home/测试核心，实际二进制 0.167.0-alpha.3.2；覆盖冷重启权限及原生目录，不重启线上 0.167.2。日志：/private/tmp/agent-bridge-relay-native-adjacent.tap。既有 partial case 保持原边界。

## 现场只读验证的限制

新 relay 对同一原生服务的小 fs/readFile 可在约 2 ms 返回，目标 thread/read 为 idle；但 84 MB 原生整文件读取在 20 秒探测预算内未完成。84 MiB 的隔离传输通过不能替代该真实大文件的恢复验收。未输出或保存用户记录正文，也未人工重放截图请求；待转发原件、原目标和回执保留。

## 发布状态

源码版本递增至 0.6.4，尚未发布 npm；部署与原消息恢复结果另行核实后记录。不能以测试通过或版本号变更宣称线上已经修复。
