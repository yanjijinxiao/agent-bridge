# 原生恢复与 Gateway 重启

恢复协调器只处理已核对的原生失败。它不接管普通输入、不重新发送旧提示、不用换模型或换执行器掩盖故障。SystemErrorRecovery 与 CapacityRecovery 分开保存事实，不能用同一个“失败”状态推导两种操作。

普通输入“原生已接收、Gateway回执未落盘”的恢复不属于上述失败协调器；它由来源journal、AccountManager只读核对和Hub结果日志处理，不启动推理。6种真实SIGKILL场景与边界见[普通输入恢复记录](../../audits/2026-11-01-four-layer-recheck/2026-11-02-native-crash-recovery.md)。恢复读不挡Gateway发布，结果发送仍按原通道交接保护。

## 系统状态重载

真实入口：AccountManager 的原生状态观察/提交前检查 → SystemErrorRecoveryCoordinator.request → AppServerCodexRunner.recoverSystemError。scope 是 host/thread/failedTurn 三元组，不能按工作目录或群名归并。新的输入、换绑、执行代次变化及未知提交会使旧 guard 失效。

恢复前再次读取持久状态、runtime、最新失败轮、活动轮、待审批/提问及原生队列。旧失败已结束、仍有执行、排队输入或活动 Goal 时不能借状态修复启动推理。原生恢复使用同一 thread 的 unsubscribe/resume 或 archive/unarchive 生命周期，没有 turn/start，也没有空提示重试。适配器返回“recovered”后还要独立读取原生状态才报告成功。

archive 前将 restoreActive 义务持久化，未确认 unarchive 不能清掉它。Gateway 重启后先恢复原活动状态；落盘失败则不发 archive。订阅释放后原生仍持有故障运行时时只读等待，有等待上限和冷却，不反复 resume 重置时钟。

## 容量恢复

真实入口：确认的 model-capacity 失败 → CapacityRecovery.offer/request → 有限退避 → 原生空输入 continuation。每次 continuation 有独立 client ID，原失败轮与接收轮分别记录。队列、用户新输入、权限与精确尾轮检查优先；回执未知保留 uncertain，不自动再次提交。重启只核对既有接收，不能从历史扫描新授予一次执行。

waiting 是持久计划，checking/settling 是只读对账，submitting 是未完成交接，running 必须有准确 acceptedTurnId。新失败与旧链的交错通过代次和记录身份核对；旧查询返回不能覆盖后来的链。已结束历史卡只退休其投影，不重放 accepted 创建新运行卡。

## 重启保护由谁承担

原生 App Server transport 跟踪实际 RPC 写入和答案 flush；独立原生服务已接收的任务继续执行。恢复协调器的 snapshot、冷却和只读对账不额外锁住重启。Capacity 的终态及退休卡片投递另有交接计数，实际结果投递仍受保护。

SystemErrorRecovery.stop 退休 source token 和 journal writer，不等待只读 pending。迟到读与补偿回调不能覆盖继任进程的恢复文件。退出前已持久化的 restoreActive 仍由新进程核对补偿。私有 stdio 执行器生命周期仍属于启动它的进程；不能把这种连接说成已独立托管。

## 已验证的具体边界

system-error-recovery.test.ts 核对精确失败、队列/活动排除、已保存回滚义务、冷却、过期来源、只读等待不锁重启、停止后的磁盘不被旧回执覆盖，以及 transport 真正写入仍阻塞。capacity-recovery.test.ts 核对退避、独立接收、终态投递、checking/settling 退休。相关本轮边界测试56项通过，系统恢复另37项通过、2项真实原生默认跳过；全量显式原生回归另记最终日志。

这些是注明场景的证据，不代表供应商任意崩溃窗口全部验收。Gateway、原生执行、平台投递和用户客户端可见仍是四个独立事实。
