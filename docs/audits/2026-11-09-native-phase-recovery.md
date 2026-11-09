# Codex 进行中阶段正文缺失

用户截图中原生界面已有后续阶段成果，钉钉卡只剩首段和截断的第二段，随后出现工具状态。核对发现两条不完整正文入口：readThreadSnapshot 直接投影 summary 项目；rollout 监听对三种 commentary 格式统一截断至 600 字符。

官方 [App Server 文档](https://developers.openai.com/codex/app-server#list-thread-turns) 区分 summary 与 full 项目视图。仓库原有 codex-read-isolation fixture 也明确在 summary 下省略 commentary；此前阶段展示测试直接喂入完整正文，没有覆盖这一前置丢失。

## 四层范围

1. 架构：完整阶段正文与有界思考/工具活动分开；修复原生读取侧，不改变渠道模板、Herdr 滚动窗口、输入回执或执行入口。
2. 模块与异常：20 轮 summary 扫描维持原预算；仅对活动 head 增加一次 limit=1/full 补读。身份不匹配、摘要回退、补读失败均不覆盖原阶段。全部读取后复核运行状态，后台观察不启动或重放输入。
3. 文件和函数：逐行核对 app-server-runner.readThreadSnapshot/nativeTurns/parseThreadHistory、codex-session-monitor.processEvent/processResponseItem/processCompletedItem，以及相邻 ThreadEventHub.deliver、阶段投影、渲染和 checkpoint 恢复链。仅前四个实际改动函数更新本次函数记录，不声称重读全库。
4. 静态与配置：新增协议替身、四个原生快照场景和三格式长正文测试；同步功能合同、需求 case、模块说明和变更日志。没有修改渠道模板、权限、用户配置或状态 schema。

## 复现与 case

修复前 native-phase-snapshot 的普通轮询与重启两条用例均失败：只保存第一段阶段正文，没有第二段；错轮补读反例也未被触发，因为没有进行完整读取。日志摘要为本次隔离证据，不复用旧通过数。

- native follow retains full commentary across summary snapshots and compaction (restart=false/true)：真实 AppServerCodexRunner → ThreadEventHub → checkpoint → DingTalk 正文转换；保留三段成果与同一张卡，私有工具输出不进入正文；读取失败保留已有阶段。
- native commentary hydration refuses mismatch/badView instead of publishing incomplete or foreign text：错轮与返回 summary 均拒绝。
- all public commentary record formats retain phase text beyond 600 characters：event_msg、response_item 和 item_completed 均逐字保留长正文。
- 既有 codex-read-isolation 的历史工具大输出反例继续通过：非活动历史不扩大为 full 扫描；历史只读连接不回答审批或执行控制。当前活动轮 full 仍可能包含该轮工具输出，受原传输帧及请求预算约束，投影器不会将它转发。

类型检查通过；完整 Gateway 回归 3,774 项，3,683 通过、91 按环境条件跳过、0 失败。新增五条场景与相邻阶段/只读/监听回归通过。没有把跳过算成已验，也没有在真实群发测试卡；截图对应的旧 inventory 绑定目前已归档，未恢复或重启该原生任务，因此不声称重现了那次截图的全部时序。

## 发布状态

上线与制品身份另行核对，不由源码测试通过推定。
