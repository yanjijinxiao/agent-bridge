# Connector facade 接口表

调用约定：非 `peer:` host 直接委托既有 facade，参数和回调对象原样保留。`peer:` host 经授权 RPC；设备侧不接收 Gateway 的 host 标识，使用本机原生服务。参数、返回值、能力位以 `src/codex/backend.ts` 为准，穷尽清单以 `src/peer/contract.ts` 为准。

| 公共端口 | 传输方式与约束 | 主要验证 |
| --- | --- | --- |
| backendInfo | 注册能力；可选原生能力按设备实现声明 | native-compat、complete-contract |
| run / steer / submitThreadMessage / stop / interruptTurn | 精确 thread/turn、来源守卫、接受身份；新线程需要设备授权 | transport-contract、write-boundary |
| listSessionCatalog / listThreads / listProjects | 原生目录、过滤、分页及 host 投影；路径在设备侧确认 | management、bridge、transport-contract |
| inspectThread / readThreadSnapshot / getHistory / getHistoryPage | 保留 persistence/runtime/turn；missing 不转成通信失败；观察预算透传 | transport-contract、native-compat |
| getRuntimeInfo / listModels / getAccountRateLimits | 设备模型与模型级用量；Gateway 默认不覆盖 | native-compat、transport-contract |
| getGoal / setGoal / clearGoal | 同一原生目标，不新增调度器 | transport-contract、main-orthogonality |
| listSkills / listMcpServers / serverIdentity | 原生目录/诊断；进程诊断限定设备授权 | transport-contract |
| createThread / renameThread / archiveThread / unarchiveThread / deleteThread | 原生管理，写前检查；删除仅限已归档；空线程的持久化由原生首条输入决定 | management、transport-contract |
| addQueuedSubmission / listQueuedSubmissions / deleteQueuedSubmission / runQueuedSubmission | 原生队列；持久来源映射；排队后回调继续有效；未知不重发 | complete-contract、transport-contract、real-native |
| resumeAfterCapacity / recoverSystemError | 复用主协调器、来源守卫及回滚日志；不重放 prompt | complete-contract、原生恢复回归 |
| readTurnLifecycle / readTurnActivities / readThreadProvenance | 保留原生观察权威；没有 provenance 时返回 undefined | native-compat、input-recovery |
| observeThreadInteractions / unobserveThreadInteractions / interactionSubscriptionReady | thread + consumer 独立订阅；原对象与确认事件；断连退休 | interactions、write-boundary |
| stageAttachments / fetchOutputFile | 上传/下载、哈希、大小、scope、临时文件 lease；不读 Gateway 同名路径 | files、sharing |
| findNativeInputReceipts / withSource | 恢复原账号/聊天/操作者上下文、唯一原生 client ID | input-recovery、complete-contract |
| warmUp | 所选设备的原生 warmUp；固定授权需匹配 cwd | transport classification |
| runEphemeral | 无 host 参数，保持 Gateway 自身临时任务职责 | main-orthogonality |
| hasInFlightWork / hasRestartBlockingWork / isIndependentObservation / detachIndependentObservations / close | 合并本地与远端观察租期；动态工具依赖 Gateway 回调时不冒充可独立分离 | execution、input-recovery |
| systemErrorLifecycleRecovery | 生产 facade 的恢复能力标识；设备恢复仍经版本、端口和授权检查 | complete-contract |

## 参数、回调和错误

- 运行参数包含 model/effort、项目上下文、协作模式、outputSchema、dynamicTools、显式 nativeSettings 和设备图片路径。省略设置保持原生继承；委托用户不能提升设备原生权限。图片必须落在获准设备工作区。
- `assertCurrent` 在原生最终写入前回调来源；`onThreadCreated`、`onTurnStarted`、`onQueueStarting` 维持原持久化顺序。delta/item/progress/recovery、审批、问答和动态工具结果沿同一操作返回。
- 审批/问答的结果回调使用原请求对象；无 handler、断连或回调失败不生成拒绝决定。动态工具回调不存在时不伪装工具成功。
- capability、queue-admission、run-admission、thread-state、intervention、turn-failed 和 communication 进行类型适配。通信区分未提交、可能提交和已接受后的观察失败；原生错误里的私有 provider 正文不回传。
- 帧上限 1 MiB、每方向 256 个在途 RPC、回调注册上限 512。超限报错，不截断后伪造完整历史。长任务断连按观察失败处理，不触发第二执行器。
