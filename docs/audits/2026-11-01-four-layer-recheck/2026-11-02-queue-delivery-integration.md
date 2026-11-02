# 队列终态与原卡投递联合核对（2026-11-02）

对应CTRL-03.3。既有映射只断言runner保留completed/failed/interrupted，没有在同一场景验证真实投递日志和AccountManager回调。本轮先记录路径与验收条件，再补8项联合检查；相关136项全部通过，无业务代码改动，也没有把此case升级为完整验收。

## 实际路径与事实源

NativeQueueCoordinator持久来源回执 → BridgeService.recoverNativeQueue → CodexAppServerGateway.runQueuedSubmission只读核对原turn → Bridge接收终态 → AccountManager.onTurnStarted不按终态启动进展 → ThreadEventHub按completed日志去重 → 渠道发送/更新回执。

入口分别在src/bridge/native-queue.ts、src/bridge/service.ts、src/codex/app-server-gateway.ts、src/server/account-manager.ts与src/server/thread-event-hub.ts。原生轮次事实、队列交接是否处理及结果是否已送达是三份事实，不能互相覆盖。

## 本次验收条件

- 通过真实Hub和渠道端口先确认旧轮次的结果，再保留未标delivered的队列来源回执，模拟投递成功与队列记账之间的恢复。
- completed/failed/interrupted迟到接收均不能新建进行中卡；有新轮次时不能替换其原卡或写入旧结果。
- 队列日志、管理器和Hub重建后仍不得重复原生add/start或重复投递；不只在内存中去重。
- 正常未完成的队列轮次仍能开进展卡并交付最终结果，避免以关闭所有展示获得通过。

原生端口与渠道传输使用受控替身，真实编排、原生适配器和持久记录不替换。这里不模拟真实Codex进程accept/fsync间被杀，不替代供应商/手机验收。CTRL-03.3的已测边界和剩余范围已同步到需求JSON与剩余清单。

## 结果与读取范围

test/queue-delivery-integration.test.ts的三终态×有无新轮次6项，真实Hub先通过能力层确认旧结果，然后管理器按原生产构造重新加载队列和投递日志；每项再重建一次，仍零新增消息/卡片、原卡checkpoint不变、原生add一次/start零次。测试只包装生产回调用于记录事件，仍调用AccountManager原回调，不能以替换终态回调来凑零发送。

本测试显式调用生产service.recoverNativeQueue入口，没有等待管理器的5秒调度器。与该路径无关的rollout/交互monitor采用空测试端口，避免读取真实用户Home；本组不验证其自动触发或重连。

第7项设置原生owner仍为活动轮次，队列只保留running而不结算、不重开旧卡。第8项是正常对照：新的pending输入必须有一次原生执行、一个新进展卡、active的true/false变化和一次最终结果；再次恢复不补发。管理器、队列和Hub的对象重建都在本机测试进程内，不写成launchd或真实Gateway进程重启。

定向回归运行新文件及native-queue、native-turn-lifecycle、late-queue-presentation、presentation-input-lifecycle、account-manager、queue-terminal-correction，共136项通过、0失败/跳过。实际测试名与当前测试文件散列追加到test-results.jsonl；最终把入队准备也经过原生facade并补齐替身端口形状后，新增8项再次通过。本轮未重跑完整发布检查，不能把136项、再次8项与上次2691项相加成新全量结果。

首轮6项都停在queued：原因是测试替身只提供backendInfo函数，漏了原生端口的id/capabilities属性；facade无法确认原后端身份，因此正确跳过核对。补齐真实端口形状后原业务断言通过。首轮日志保留私有临时目录，不当作产品缺陷或宣称已修复了业务bug。

## 四层核对

- 架构：执行事实、队列交接与结果投递三方职责不合并；只读恢复不能借此启动原生输入。
- 模块：联合真实队列协调、Bridge、facade、管理器与Hub，保留三终态、活跃新轮次和正常执行对照。
- 文件/函数：核对NativeQueueCoordinator.reconcile/dispatch、facade的observeOnly、Bridge的接收及finalize、AccountManager终态回调和Hub原卡去重；新测试逐行记录，原业务源码未改。
- 静态/配置：同步功能JSON、模块与剩余清单和当前索引；不改变账号权限、配置或重启门禁，不触碰真实渠道/原生用户任务。
