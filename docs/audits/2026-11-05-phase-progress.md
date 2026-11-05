# 2026-11-05 阶段进度与会话恢复标题

## 用户证据与根因

本轮逐张查看三张附件：一张先显示原生代理/CONNECT 失败、随后显示“已完成”；两张对比公开 commentary（红框）与工具/公开摘要（蓝框）。线上只读记录确认相关远端轮次 lastTurnFailure.code=network-proxy，runtimeStatus=idle、runtimeRecovery.phase=recovered。恢复不重发失败任务。此记录不能进一步证明代理服务、网络还是上游的具体故障点。

原实现 meaningfulProgress 只保留四条 update，renderTurnProgressCard 又只展示两条旧进展；当前 commentary 和旧窗口会重复。ThreadEventHub.systemRecoveryNotice 把 recovered 用默认 completed outcome 结束恢复卡，造成“原任务失败后又完成”的误导。原生摘要 delta 将同一 item 的不同 summaryIndex 拼接，可能粘连两个 Markdown 标题。

## 四层检查范围

1. 架构：对照 delivery-channels、phase-progress 和 DEL-08，确认原生执行终态、会话恢复、渠道投递、卡片阶段是不同事实。自动换卡只改展示，不提交、停止或切换原生任务。
2. 模块：检查 ChannelTurnPresentation 的串行入口、新旧实例持久化、closeSegment 重试、suspend 和下一轮隔离；ChannelTurnTextStream 的加载/恢复、进度、心跳、最终分页；ThreadEventHub 的独立恢复通知与来源 guard。
3. 函数：逐行核对本次新增 phase-progress 的分类、阶段结算、有界活动、Markdown/Unicode 字节拆分；progressParts、progressWouldOverflow、stageSummary、rotateProgress；阶段渲染、旧 checkpoint 迁移、独立 summaryIndex 与恢复 outcome。旧版本已经淘汰的历史说明无法凭空恢复；新数据单独持久化。原生 text-only 渠道继续原文字聚合行为。
4. 静态/配置/文档：原 DingTalk 卡模板、静态页脚、复制控件和 IDE 装饰器保持职责；检查现有文档链接、JSON 要求矩阵、双语 README 和探探教程。没有修改授权、设备凭据或新建部署配置。没有把教程固定到某个 Git 版本。

## 复现与回归

- 同一组 42 项用例在 HEAD=3ae8919 的隔离副本运行：33 通过、9 失败。失败覆盖阶段丢失、缺少换卡、超长内容、旧卡异常/创建未知、摘要拼接和恢复标题。
- 最终相关组合：84 项全部通过。另含重复字符超长、转义扩张、中文/emoji、失败工具不冒充任务终态、创建未知不重建、重启复用句柄、原停止复制框与 IDE 页脚保留。
- 最终全量：3331 项，3245 通过、86 条件跳过、0 失败。typecheck、隔离编译通过。
- 证据目录：/private/tmp/gateway-phase-progress-20261105；before.log、final-targeted.log、final-full.log、typecheck.log、build.log。

测试使用真实投影、持久化、事件分派组件及模拟渠道回执，覆盖 DingTalk Markdown 处理后的字节预算。没有向真实群发送测试消息，也不声称做了手机实机像素验收。原生代理故障的具体根因不在本次展示修复的已验证结论内。
