# Herdr 两套适配：增量四层检查

日期：2026-11-07；Git 基线 37b2a2c，产品目录版本 0.5.0。**当前源码已接入生产 Connector 和普通 IM 主链路，完整功能仍未完成，未 push、发布或切换线上。** 本报告不代表全仓每一行均已重新审查，也不把新增测试合并到旧版 427 个需求 case 的完成数。

## 证据入口

- [持续跟随增量](follow-increment.md)：四层范围、26 个新增用例及投递修复。
- [生产四层清单](production-checklist.md)：要求、代码、具体测试及未完成边界。
- production-requirements.json：17 项功能合同、正交边界和精确测试映射；pending/partial 保留，不并入旧需求完成数。
- production-verification.json / production-test-results.jsonl：最终测试结果、测试名、文件及散列。
- production-read-ledger.json：完整文件阅读、局部函数核对、仅类型/回归覆盖分别记录。
- [架构设计](../../architecture/herdr-adaptation-design.md)、[运行模块](../../architecture/modules/agent-runtime.md)、[命令合同](../../architecture/agent-command-compatibility-2026-11-07.md)、[真实环境](../../architecture/herdr-test-environments.md)。
- [初版适配器检查](initial-adapter-review.md)、verification.json、code-review.json 是历史 55 项检查点；旧散列不表示当前版本通过。

## 第一层：架构与事实源

当前验证汇总：全库 3600 项，3512 通过、88 跳过、0 失败；Herdr 增量 206 个唯一用例通过（本次新增 26 项）。本次全库包含前次退出清理小修和本轮持续跟随改动；最终 typecheck、隔离编译及编译产物 CLI help 通过。上一检查点单独保存在 before-follow 文件，不能用旧散列表示当前代码通过。

执行仍为 Gateway → 已选择 Connector → 明确配置的运行接口。TUI 使用公共 JSONL；App 使用窗口目录和同一固定 core 的执行接口。无自动切换、无备用 Codex 实例、无第二套授权或 IDE。

终端资源和 native thread/turn 分开；screen 不能触发附件动作、审批答案或成功终态。原生设置/队列/审批不通过键入 slash/yes 模拟。短交接结束就释放重启阻塞；持续观察不拥有任务生命期。

四类持久事实分别归属：Connector 输入交接；Gateway 入站来源；Gateway 卡片观察/投递；原生程序状态。runtimeReceipt 只核对原来源、目标和指纹，不调用 send。查不到回执仍为未知；终端 idle 只表示观察到空闲。

## 第二层：模块与场景

新增测试覆盖生产 Connector 子进程、真实本机 WS/JSONL、普通 Bridge 消息入口、授权和共享撤权、附件字节、隔离 IDE 进程/HTTP，以及公共卡片展示组件。测试替身在 Herdr 或 IM 边界，不能当作真实钉钉手机验收。

恢复覆盖交接子进程真实 SIGKILL、生产 Connector 重建、Gateway 实例重建、丢失确认、持久化失败、同来源重复和并发中断。证据分开保存；未做线上完整 Gateway 进程骤停后的真实钉钉卡片验收。

Mac App/core 与 Linux 12 TUI 实际版本和只读接口再次核对。此前真实输入证据保留；不宣称此次所有 agent 的输入、中断及生命周期均已实机通过。

## 第三层：函数核对及修复

1. 离线 Herdr 原可能被当成 Codex 全能力；改为保留最后已认证描述，从未连接明确未知。
2. 观察原只有读前核验；补读后原目标校验，读中撤权或替换丢弃画面。
3. 并发中断原可能跨 await 重复进入；以持久 begin 返回为准，增加资源级短互斥。
4. 入口握手纳入清理边界，用真实子进程验证失败退出及 socket 关闭。
5. @ 合并卡先检查渠道能力；不支持时通知，未知通知不重放。
6. 补只读回执查询：Connector 已确认但 Gateway 丢响应可修复原来源和卡片；先修复来源再更新观察记录，写盘失败保留恢复义务。
7. RPC 响应核对目标、指纹、终端实例及错误枚举；伪造 native turn 或畸形错误不能把写入降为未发送。
8. App 多空间归属原仍可能选第一个项目。两个反例修复前失败；修复后保持未归属并报告不完整，与 inspect 一致。
9. blocked 不伪装聊天问答；不支持中断的卡片不提供停止控件；有接口时仅写请求中断，不承诺取消成功。
10. 退出清理原依次 await，IDE 清理失败会跳过运行接口与进程锁。改为分别尝试并汇总失败；逐资源注入失败和生产入口回归通过。前次检查点在全库之后单列，本次已纳入全库。

初次实机暴露的 TUI EPIPE、pane 与 terminal_id 区别、PRIVATE 字段误用及 JSONL/UTF-8 修正保留历史证据。上游无通用原子 compare-and-write；observed 身份不能保证识别所有同类程序替换/PID 复用窗口。

11. 补上只读持续跟随、原卡重建、空闲基线和重复周期。输入卡优先，follow off 不取消输入结果义务；stream 切换保留原卡和 IDE。
12. 显式重试原先只覆盖进行中卡片，终态卡被漏掉；已保留 [失败证据](follow-retry-before.log)，补上原终态投递分支。初次夹具缺 synchronize 方法的错误与实际 0≠1 复现分开记录于[本次增量](follow-increment.md)。

## 第四层：配置、文档与构建

严格配置分开 runtime 选择和 wire/build 身份，拒绝混入 Codex host/profile/binary，保留旧 Codex 默认。runtimeContract:1 单独协商，56 个 facade 端口显式分类；这是尚未发布的新协议定义。日志不记录 prompt 或供应商任意错误正文。

README、探探教程、模块、设计和剩余表标明源码开发中。typecheck 不生成文件，编译使用临时 outDir，不覆盖线上 dist。失败历史、夹具修正、跳过项目及设备限制分别记录。

完整新建/命名/生命周期、持续跟随实机验收和多参与者通知、全部命令/别名/旧按钮/Web/Taskboard 一致性、App 远端文件/IDE、真实跨设备与钉钉往返仍待完成。**已有回归通过不等于完整适配，不据此上线。**
