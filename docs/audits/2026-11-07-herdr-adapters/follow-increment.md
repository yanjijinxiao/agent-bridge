# Herdr 持续跟随增量核验

2026-11-07。源码改动尚未发布。当前全库 3600 项：3512 通过、88 跳过、0 失败；本增量新增 26 个用例，Herdr 专项累计 206 个唯一用例通过。typecheck 和临时 outDir 编译、CLI help 通过；未覆盖线上 dist。

## 第一层：架构和正交性

被动跟随拥有只读订阅及展示周期，不拥有输入、任务或原生轮次。输入交接义务独立保留；关闭跟随不取消输入结果，关闭过程展示不取消最后结果。两种 Herdr runtime 共享观察模块、角色/绑定代次校验和卡片组件，不在渠道中分品牌实现。

原生 liveFollow 能力继续用于 Codex 事件监控，Herdr 不伪造该能力。其进度展示来自 inspect/read。普通输入卡优先于被动卡；每次 tick/sync 先核对被动订阅，再退休输入结果，避免快速结束导致同一次结果被两条路径重复展示。

## 第二层：模块和功能

runtime-observation 新增 16 个用例：空闲基线、连续外部运行、重建和重复 on、follow off 与输入独立、输入卡优先、stream off、断连后新快照、序号改变、未知状态、撤权、三种目标替换、显式终态重试、关闭已有卡、未知卡证据保留和并发同步。

runtime-channel 新增 10 个用例：TUI/App 分别验证真实 Bridge → 本机 Peer WebSocket → 运行适配器边界；外部连续运行、重建与重复同步、follow off、stream off/on 复用原卡及 IDE、primary 不修改原生交互。IM 和 Herdr 程序为协议替身，不等于供应商账号或手机验收。

## 第三层：函数和异步边界

- follow：同一绑定复用原授权来源，固定资源实例；不把后续参与者静默写成订阅所有者。
- observeNow：读前和读后核对原实例及来源；初次空闲不产生完成卡；已知状态只记录为终端观察。
- refreshPresentation：等待该观察的进行中读取，停止旧卡计时器，再从 checkpoint 恢复。保留原卡身份及投递证据。
- synchronize：与后台读取互斥；显式 retry 对原进行中卡和原终态卡分别调用对应恢复入口，不提交或中断任务。
- resetFollow：结束一个展示周期而非删除订阅；输入接管时保留未知创建证据，不凭没有 messageId 丢弃原卡事实。
- handleRuntimeFollow：查看、订阅开关、同步和人工重试分别检查角色；primary 没有结构化交互契约，明确返回限制。

实际发现：原同步分支对已持久化 terminal 的卡只调用 synchronize，底层会直接返回 finished，因此人工重试未送达的终态卡没有生效。修复前精确用例 0≠1，见 follow-retry-before.log；当前全库同名用例通过。第一次测试夹具缺少 synchronize 方法导致 TypeError，修正夹具后重新在旧路径隔离复现；该 TypeError 不算产品缺陷证据。

新增文件完整读取、共享 service 的改变函数与调用边界另记 production-read-ledger。不是全仓每一行已重新审查。

## 第四层：配置、静态内容与文档

journal 保留 version 1，可选 following/lastSequence/lastSyncedAt 字段与旧输入记录兼容。未增加执行器切换或重启门禁。README、探探教程、运行模块、持久状态模块、命令合同、剩余清单及功能 JSON 同步；依旧标明未发布。未新增模板、前端页面、外部依赖或生产配置。

原卡、IDE、复制控件沿用公共展示；终态重试的复制不会执行命令。不同角色和不同运行接口的执行权限不从展示状态推导。

## 明确保留的边界

真实 TUI/App/探探跨设备和手机、完整 Gateway 进程骤停后真实卡片恢复仍未验收。仅重建 Gateway 对象不等于这些场景。观察 journal 对 checkpoint 仅做基础结构校验，完整公共 checkpoint schema 尚需统一；撤权时无法确认曾经投递的卡片不能承诺远端一定退休。

没有状态序号时，轮询间隔内开始又结束的外部任务可能不可见；不据屏幕内容猜一个原生轮次。被动订阅没有输入参与者，暂不发伪造的完成 @；多参与者通知仍未完成。资源新建/命名/关闭、无 cwd 绑定、全部命令/Web/Taskboard 和远端 machine 文件/IDE 仍在剩余表中。
