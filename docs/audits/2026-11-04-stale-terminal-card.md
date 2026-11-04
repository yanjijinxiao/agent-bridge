# 已结束任务仍显示停止入口：定位与定向回归

## 证据与原因

用户截图中的任务在 2026-11-04 12:39:46（北京时间）已有原生 task_complete 回执，包含完整纯文字最终答复。Gateway 的对应卡片仍为 unfinished / unconfirmed，无终态投递回执。同一会话留有 10 月 28 日 queued、未映射 turnId 的旧记录；完成通知处理报错后，历史读取持续超时。

AccountManager.applyNativeResult 在判断最终答复是否包含外部动作之前，先核对旧队列来源。纯文字结果也进入慢历史读取；读取失败会使 ThreadEventHub.finishNow 在更新原卡之前抛错。卡片随后被观察失败改为“执行状态待确认”，却仍提供作用于聊天当前任务的通用停止命令。

## 修复和四层范围

1. 架构：区分执行完成、最终正文投递和附件/记忆动作授权。纯文字结果无需旧队列动作归属；未删除旧队列记录、未伪造输入回执、未重发或停止原生任务。
2. 模块：AccountManager 仅在解析到 send/remember 动作时执行原授权链；ThreadEventHub 和原卡回执仍负责去重。活动状态确认丢失时，展示层去掉通用停止入口。
3. 函数：检查 applyNativeResult、finishNow、completion/recoverCompletion、renderTurnProgressLayout/renderTurnProgressCard 和钉钉 HTTPS/SDK 状态切换；补同线程旧队列＋历史不可用＋纯文字原生完成＋重建恢复的联合用例。
4. 静态/配置：检查固定卡片尾区、等待态静态区、结束态正文以及 IDE 页脚组合；更新模块文档和 case 映射。未更改权限、模板配置、执行器或状态文件格式。

## 测试

隔离副本使用修复前源码运行两个新增用例，均失败：纯文字结果被 history offline 阻塞；待确认卡仍暴露停止命令。修复后定向回归 23 项全部通过，类型检查通过。

- `queue-result-recovery.test.ts` 的 plain-result：真实 AccountManager、NativeQueueCoordinator、ThreadEventHub 及卡片流组合；纯文字结果更新原卡一次，旧历史读取次数为零，结束后观察失败、管理器重建和重复完成回执均不恢复停止入口。
- 同文件原有 read-failure/retired/other-turn：含附件/记忆动作仍要求原输入授权，读取失败不得执行动作，不放宽跨轮次边界。
- `compact-progress-design.test.ts`：未知状态无停止控件，明确等待/恢复状态仍有控件。
- `dingtalk-progress-layout.test.ts`：HTTPS 与 SDK 两条实际适配路径均检查未知状态移除控件、恢复运行重新显示、结束后移除，以及 IDE 页脚保留。
- `turn-result-actions.test.ts`：动作日志、重复回执、发布冻结及权限边界回归。

本次是故障相关路径的增量四层检查，不是全库重新逐行审计。完整发布回归和线上卡片恢复以发布后的实际结果为准；手机像素呈现未验收。旧队列记录自身的历史读取超时没有被伪装为已修复或已确认。
