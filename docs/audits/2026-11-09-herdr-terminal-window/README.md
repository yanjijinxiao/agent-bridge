# Herdr 单卡终端窗口

2026-11-09 用户明确取消 Herdr 的 Codex 式阶段分类：一张 AI 卡尽可能显示终端字符，容量不足时去掉最早的字符，保留最新末尾。本次实现取代[此前的终端分类实验](../2026-11-09-herdr-terminal-display/README.md)。Codex 原生 App Server 的结构化阶段展示保持原有行为。

## 实现与边界

- Herdr 观察器调用 terminalScreen，替换当前卡的有界窗口，不再按 agent 名称或终端行前缀判断助手、工具、阶段，也不因内容长度创建续卡。
- TUI 读取最近 512 行 recent_unwrapped；App 仍只读 screen，避免为收集历史而滚动正在使用的应用。未被上游返回的历史不会被补造，窗口不是完整终端日志。
- 钉钉终端卡使用独立的 50,000 字节安全预算。计量同时覆盖原文转义、渠道 Markdown 转换、状态、停止控件、IDE 页脚及加载行预留。普通原生答复仍使用原有分页预算。
- 保留换行和缩进，只移除 ANSI/控制字符。终端中的链接、代码围栏、HTML 与动作标记按文字展示，不生成额外复制控件或附件动作。
- 窗口最多持久化 50,000 个 Unicode 码点；恢复沿用原卡 ID。旧阶段 checkpoint 在下一帧迁移为窗口，保留投递回执。已冻结的最终投递计划不重写。
- 断线保留最后画面；阻塞/状态不明不冒充运行成功。结束仍更新原卡，移除停止控件、保留 IDE。stream 关闭时只发最终有界文本。

## 四层检查

| 层 | 检查范围 | 证据 |
| --- | --- | --- |
| 整体架构 | RuntimeOutput → 观察器 → TurnPresentation → 渠道；展示与输入交接、身份、状态、原生执行分离 | Codex 原生 item、队列、审批及阶段回归与 Herdr 回归一同通过；没有为展示变更执行入口 |
| 模块与异常 | App/TUI、任意 agent、stream 开关、断连恢复、运行/阻塞/结束、旧 checkpoint | 观察器矩阵和真实 HTTPS/SDK 序列化链路；单张卡、无续卡、恢复 ID 一致 |
| 文件与函数 | terminal-presentation 全文件；观察器 read/finalize；流的 checkpoint/render/finalize；TUI read；钉钉 active layout/measure | UTF-8、中文/emoji、长单行、转义膨胀、空画面、预算耗尽、历史覆盖、字面量标记及实际序列化预算测试 |
| 静态文件与配置 | 新 checkpoint 可选字段与旧格式兼容；渠道能力声明；功能合同、模块、需求覆盖、教程、README | 严格 schema 用例、文档相对链接检查；模板、账号权限和服务配置没有变化 |

本记录只覆盖上述改动及相邻回归，不声称逐行检查了整个仓库，也不以隔离测试代替真实钉钉客户端验收。

## case 对应

| 文件 | 本次覆盖 |
| --- | --- |
| terminal-presentation.test.ts | 最大可用末尾窗口、ASCII/中文/emoji/转义、超长单行、保留所有行类型、非交互文字、空值与状态控件预算 |
| terminal-observation-presentation.test.ts | 8 组重启 × stream × agent 矩阵；旧阶段 checkpoint 迁移；每帧替换、断线保留、结束同卡、IDE/stop 生命周期 |
| dingtalk-terminal-window.test.ts | HTTPS 与 SDK 两条真实渠道序列化路径；接近 50 KB 的正文、稳定小于 1 KiB 的流式页脚、恢复/阻塞/结束、不分页 |
| agent-runtime.test.ts | TUI recent_unwrapped 512 行请求及截断信息；App screen-only；读前后资源身份核验 |
| stream-checkpoint.test.ts | 新窗口恢复、版本/类型/大小拒绝；旧状态兼容 |
| 其他相邻回归 | RuntimeObservation、Codex 原生 item/App Server/peer、阶段卡、控件、IDE 页脚、公共进度及 Web runtime |

类型检查及 297 项相关回归通过，0 失败、0 跳过。完整命令、测试清单和源码散列见 validation.json。发布状态另行记录，不能从本文件推断已上线。

## 真实接口预检发现与修正

发布前在 Linux 12 的 Herdr TUI 0.9.5 做只读调用，发现初版使用 CLI 别名 recent-unwrapped 时 JSON 请求被拒绝。上游 src/api/schema/common.rs 的 ReadSource 明确使用 serde snake_case，src/cli/agent/bindings_tests.rs 也明确生成 recent_unwrapped。已按原生 JSON 合同修正，并让回归 fixture 拒绝 CLI 别名；修正前用例失败。初版制品未切换线上。真实调用只输出版本、行数与字节数，不输出终端正文或配置凭据。
