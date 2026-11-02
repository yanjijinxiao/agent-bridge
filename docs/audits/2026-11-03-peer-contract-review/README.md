# Connector 与 main 功能/模块契约审查（2026-11-03）

## 结论

审查代码为 `codex/gateway-peer-transport 4bb6cd2`；本轮重新 fetch 后，`origin/main` 仍为 `f108f81`，分支不落后、领先 17 个提交。**撤回此前“当前分支可直接作为实验功能合入”的结论：本轮确认两个 P1 行为问题，修复并验证前不建议合并。**

这是按 main 功能和模块契约进行的差异审查，不是整仓、所有设备或全部 310 个 case 已验收。本轮没有修改产品代码，没有 rebase、合并或部署。既有 2798 项全量检查结果仍是历史事实，不能覆盖下述新反例。

## 依据和范围

读取 main 的 `docs/architecture/README.md`、`gateway-contracts.md` 相关条目、`gateway-implementation-map.md` 和 `remaining-work.md`，并核对以下模块说明及差异调用链：

- native-protocol、bindings-access、input-controls、goal-controls。
- native-interactions、inbound-forwarding、delivery-channels。
- catalog-history、ide-access、persistent-state、recovery-coordinators、release-lifecycle。
- taskboard-native-execution 的公共后端消费边界。

上述架构文档与分支中的文件逐字节一致。历史文档中的命令、发布流程和旧需求作为审查资料，不据此发起发布或扩展本轮任务。

## 已确认问题

### P1 / A1：跨网络适配丢失最终写前的 Gateway 来源检查

依据：bindings-access 的异步等待后重新核对来源/角色要求，input-controls、NATIVE-02 的最终写前检查；CTRL-01.3 对 steer 明确规定等待中换绑/降权后不得继续写入。

位置：`src/peer/execution-service.ts:200`、`:208`；同类结构在 `src/peer/management.ts:48`、`:74`。

Gateway 最初通过 `execution.callback/assertCurrent` 核对原聊天角色和绑定，但传给原生 backend 的最后一次 `assertCurrent` 只检查 Connector 的资源授权和连接是否打开。原生连接/resume 等待期间，Gateway 上用户被降为 viewer，网络和资源 grant 仍有效；最后的本地 guard 不会得知降权。

直接反例使用真实 BridgeService、RuntimeStateStore、Peer WebSocket 和设备授权，模拟原生 backend 的准备等待：入口允许 → backend 等待 → store 将用户降为 viewer → backend 调用传入的最终 guard → 原生写入计数仍为 1，预期为 0。来源未变的正常对照写入一次。证明的是跨进程 guard 的语义丢失，不是对真实 Codex/钉钉或任意网络时序的验收。

修正方向：保留 main 的绑定代次/actor/角色 guard 为权威，设计可在原生写前再次校验、并在入口退休时失效的跨机写入授权。不能仅在进入 RPC 时检查一次，也不能把“WebSocket 仍在线”当作授权仍有效。管理接口需要一并审查。已提交但回执未知仍须保留未知，不能为了重试将其改成未提交。

### P1 / A2：审批异常或断连被转换成用户拒绝

依据：INT-01.3/.4/.6、INT-02.3；native-interactions 明确要求不能因路线不存在、重启或 UI 关闭生成默认允许/拒绝。

位置：`src/peer/execution-service.ts:223–229`；`src/peer/backend.ts:78` 也将无 onApproval 回调变成 decline。

Connector 在 onApproval 的 catch 中返回 `decline`，非法/空回调结果也归为 decline。原生 AppServerCodexRunner 会将这个正常决定写回 Codex。main 原生 handler 在回调抛错或返回 undefined 时则保留待处理请求，位置为 `src/codex/app-server-runner.ts:2264–2280`。

两项直接反例：Gateway 审批回调抛错、等待人类决定时关闭 Peer 连接。两者均没有用户拒绝，设备 backend 却收到 decline。明确用户拒绝的正常对照仍正确收到 decline。

修正方向：传输/来源退休必须保留“无人作答”，沿 main 的原生交互观察与退休语义处理；不能把异常包装成合法拒绝。断线后的重新观察还依赖尚未接入的独立交互订阅，需要单独补齐，不能只删除 catch 就宣称恢复完整。

## 架构与产品行为差异

这些与已确认 P1 故障分开，不能用“测试未覆盖”直接判为运行故障，也不能统一称作 Connector 接口必需改动。

| 模块 | 当前差异 | 判断及收敛方向 |
| --- | --- | --- |
| 原生协议 / NATIVE-01、NATIVE-03 | execution-service 将 nativeQueue/goals/skills/MCP/dynamicTools/structuredOutput 设为不支持；backend 明确拒绝精确 turn 中断、独立交互订阅和进程身份等 | 当前是原生接口子集，不符合“仅部署/传输不同、完整能力适配”的目标。仍未偷换到本机执行；但需要补适配，不能把拒绝能力视为已经完成 |
| 文件回传 / IN-06.3 | main 有 fetchOutputFile/OutputFileLease，分支增加 fetchOutboundFile/OutboundFile；Bridge 按 peer 再分一条下载路径 | 可收敛的重复业务端口。复用统一回传契约并扩展必要的 account/conversation/thread scope；SSH 和 Peer 保留各自传输及路径授权，媒体投递和副本清理共用 |
| IDE / IDE-01、IDE-02、IDE-04、IDE-05、IDE-09 | peer 的 /ide 返回新共享文本页；独立 proof/session/CSRF Map，浏览器授权 1 小时且重启失效；单 cwd，不是完整项目 roots | 是独立的受限代码浏览器，不是原 code-server IDE 已适配 Connector。main 有 90 天持久浏览器授权、完整 scope 和固定入口。保留只读资源要求，但应复用浏览器证明/持久化原语、明确资源到期上限及入口区分；不能给只读访客直接开放完整终端 |
| 准入 / AUTH、BIND | /role 计算已回到 main；新增 owner/邀请/资源委托，不走全局准入；共享 viewer 可绑定和 leave | 角色算法一致不代表准入/绑定语义完全相同。资源所有权属于此前用户明确要求，可保留；应把资源检查接入统一 guard，并补目标绑定/群成员组合验证 |
| 目录与会话管理 / CAT | 新增 IM rename/archive/restore/archived，作用于所有支持的后端；创建空 thread；修改通用项目别名与归档查询 | 有独立产品能力和通用修正，不只是 peer transport。现有回归覆盖部分路径；建议将通用修正独立说明/提交，避免 Connector 开关被误认为能隔离全部影响 |
| 输入与结果恢复 / IN-02 | Peer 对原 clientUserMessageId 做身份作用域转换；增加恢复接口，继续调用 main 的分页、唯一匹配和结果 journal | 必要适配，已有实机故障证据对应 6b9bcde。Connector 侧回执用于跨机去重，职责不同于 Gateway 入站 journal，不能仅因都有 receipt 就删除一层 |
| 卡片与渠道 / DEL | 渠道发送器、copy controls、审批/问答 controller 源码没有分支改动 | 复用成立，但下层回调语义仍可能破坏上层功能，A2 就是实例。“模块文件没改”不等于该功能没有差异 |
| 发布与独立执行 / REL | 同一重启门禁接入 Peer 已接受任务；默认 daemon，stdio 仍明确非独立 | 维持主分支职责；旧实机崩溃验收不能外推待审批时断连，A2 须作为新增门禁 |
| 双向消息接口 | createPeerChannelAdapter / attachPeerConversation 仅被测试调用，正常启动配置未接线 | 属于协议原型，不能称完整远端聊天客户端入口已交付 |
| Taskboard / 管理 UI | 页面源码未改；公共 backend 被 Peer 装饰，但上述原生目录/交互/精确停止能力缺失 | 不宣称 Taskboard 或所有 Web 控制已支持 Connector；需要按公共端口分别接入验证 |

## 直接验证记录

本轮新增 5 项隔离审查检查：**2 项正常对照通过，3 项契约反例失败，归属 A1/A2 两个问题**。未用重跑旧全量测试代替新反例。

```sh
node --test --import tsx docs/audits/2026-11-03-peer-contract-review/reproduce.test.ts
```

该文件为故意保留的当前失败审查用例，不在 `npm test` 的 `test/*.test.ts` 默认入口中。修复时应把必要反例转为正式回归，并保留正常对照。实际输出见 `reproduction.txt`。

- 使用项目真实 Bridge/角色状态和回环 WebSocket；原生后端为受控替身。
- 没有启动真实 Codex，没有发送钉钉消息，没有操作真实授权或会话。
- 固定等待点验证最终写前角色降级；审批验证错误和断连均不应造出拒绝。
- A1 的管理方法具有相同静态结构，本轮未单独运行管理方法反例；不混同为全部动态复现。

## 后续顺序

1. 先修 A1/A2，并分别验证 main 的绑定/角色/退休和审批未作答语义，恢复合并资格。
2. 统一文件回传业务端口；共同保留来源校验和目录约束，不删除必要的传输差异。
3. 逐方法补齐原生接口，优先独立交互订阅、精确停止、原生队列/goal，再处理目录与 owning UI 设置等；按模块合同标出已接通/未接通。
4. 将通用会话管理、资源共享和受限代码浏览器分别列明产品范围；原 IDE/浏览器授权与新资源访问的复用设计单独审查。
5. 更新功能/模块的 Connector 适配矩阵，再按修复影响完成自动化及实际部署验证。

## 审查版本指纹

下面散列对应本次读取的产品代码，不代表全文件所有分支均已验证。

- `src/peer/execution-service.ts`：`3541d028beaf410034afbcae52e40dda4903eb57c48474d6593002d6ace4f807`
- `src/peer/management.ts`：`b68284f67cf7eab0be602e77b6d33a07c15f1163c4715cd7eb253f134b5a78f8`
- `src/peer/backend.ts`：`7b392803645dfe9f27cfccccf2915625bc0168585baf47ad7794c906c8423dac`
- `src/peer/workspace-portal.ts`：`43de65c32320b155bb711fd85b5bc1b0eb0c674a16a8524a4d49bb4ea62e2218`
- `src/bridge/service.ts`：`530ea3ea69754ff9fbdac79bb6c5aeecd3bfd796d7086a39e6d207749f61c0f7`
- `src/codex/app-server-runner.ts`：`d496a4aff6311906e01f4a0f8acba8c2660e5bac72d9043d80bce8464874f05c`
- `src/codex/output-files.ts`：`5945a2efc6b0c950e6a6827ba8024897cc0cca757c1a5e5b24ce050e0af15b54`
- `docs/architecture/gateway-contracts.md`：`5b3cac37e0ad78f3a2a68247f6c3b652370d12911b3a0e536042efca64857a9f`
