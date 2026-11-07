# Herdr TUI / App 适配与四层检查

开始：2026-11-07；收尾：2026-11-08。Git 基线 37b2a2c，源码产品版本 0.5.0。本次定义的两套 Herdr 源码适配已实现，并完成以下隔离回归及真实两端验证；**未 push、npm 发布或切换线上**。本记录覆盖新增模块与共享修改的调用链，不宣称全仓所有历史代码重新逐行审完。

**交付验收未完成**：尚未通过探探的真实钉钉渠道做两套 Herdr 往返，也未完成真实浏览器 IDE 的完整操作。手机不是这些核心验收的前提；桌面 IM 与浏览器即可。见[验收范围纠正](acceptance-2026-11-08.md)，不能把这些缺口归结为“手机未验”。

## 当前结果

| 验证 | 总数 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: | ---: |
| 主库完整回归 | 3694 | 3604 | 0 | 90 |
| Taskboard 完整回归 | 515 | 513 | 0 | 2 |
| 实际 Herdr + 生产 Connector 入口复测 | 2 | 2 | 0 | 0 |

主库中的两项 Herdr opt-in 默认跳过，随后用真实 TUI/App 单独启用并通过，不能在主库结果中改写成通过。剩余跳过项目逐项见 production-verification.json。17 项功能合同共映射 **403 个唯一的专项及共享边界通过用例**，包含既有回归，不称为全部新增 case，也不等于穷尽所有环境组合。

根目录与 Taskboard typecheck、临时目录 TypeScript/Vite 编译、Taskboard runtime 打包、静态资源复制、两个编译产物 CLI help 均通过；补验 npm 包管理已有 3 个用例通过。Vite 保留既有大块体积提示。没有覆盖正在运行的 dist，也没有准备或发布 npm tarball。

## 文档与证据入口

- [四层清单](production-checklist.md)：从架构到静态配置的审查范围。
- production-requirements.json：17 项功能、职责、代码散列、具体测试、剩余验收边界。
- production-read-ledger.json：61 个源码/静态脚本文件的完整模块审查或局部函数审查分别登记；历史版本散列保留在 before-completion 文件。
- production-test-results.jsonl：403 个选定通过用例；root-test-results.jsonl、taskboard-test-results.jsonl、live-test-results.jsonl 分别保留完整运行记录及实际跳过项。
- production-verification.json：运行日志散列、真实场景、修复前后证据、构建与部署状态。
- [设计](../../architecture/herdr-adaptation-design.md)、[模块职责及函数意图](../../architecture/modules/agent-runtime.md)、[命令正交性](../../architecture/agent-command-compatibility-2026-11-07.md)、[实机及清理](../../architecture/herdr-test-environments.md)、[配置与使用](../../herdr-connector-guide.md)。

initial-adapter-review、verification、code-review、follow-increment 和 before-* 文件是历史检查点；不能拿旧通过数或散列代替当前结果。

## 实际发现与修复

底层阶段修复 TUI 每请求关闭连接引起的 EPIPE、稳定 terminal_id 与 pane 参数的区别、公共/PRIVATE 字段依赖、UTF-8/帧与错误响应处理。生产接线阶段修复离线能力误报、读后目标校验、并发中断、握手失败清理、回执查询与原来源修复、App 归属歧义、终态卡显式重试遗漏。相应旧失败证据继续保留。

完整适配阶段补齐生命周期持久交接、命令/别名目标表、无 cwd 绑定、Web/Taskboard 能力分离、多人原来源通知、共享远端文件和完整 IDE。真实 Linux Node 包装器使 HOME 变为 /，不同 helper 的 /tmp 不共享；现使用明确登录账户 HOME 和持久私有 socket，并等监听就绪。最后复现了文件租约在资源作用域变化后仍可使用的问题：host 解析后、下载块前、上传发布前的三个反例原先失败，现在均通过，见 [修复前](file-scope-before.log) 与 [修复后](file-scope-after.log)。

测试夹具的 receipt 字段、macOS 路径别名、画面 Markdown 转义、App 自动移除空空间，以及首次 Vite 路径调用错误均已分开记录，没有计为产品缺陷。

## 真实环境证明到哪里

Linux 12 的 TUI 0.9.5 使用真实 Codex CLI 验证创建、命名、输入、配置 Esc 中断及关闭。Mac App 0.1.13 使用原 core 0.1.18 和真实 PTY 状态程序验证对应操作。两套最后均从 Bridge 普通输入走生产 Connector 入口，SIGKILL Connector，再重建 Connector 和 Gateway 观察对象：原终端继续存在、输入不重发、原卡保留 IDE、原来源只通知一次。

App 远端 machine 到 Linux 12 的 1 MB 文件往返、共享读写/hash 冲突，以及实际 code-server health/workbench HTTP 已通过；原始 WebSocket 的 1 MB 流量另有隔离测试。IM 使用捕获适配器，**未做真实钉钉手机投递、线上 Gateway 进程 SIGKILL 或真实 IDE Git/终端 UI 验收**。清理只针对本轮资源，头头、探探及原 Connector 未动。

## 保留的语义和部署边界

Herdr 不提供等价的原生模型设置、审批、消息队列、goal、结构化工具与最终答复合同。对应操作明确说明原因，通用目录、生命周期、文件、IDE、Taskboard CRUD 和普通输入继续使用。终端 idle、键入确认、IM 投递与业务成功不是同一事实。

上游没有原子实例 CAS；最后核对之后的程序替换及 PID 复用仍有检测窗口。没有事件序号时，轮询之间瞬间完成的外部任务可能不可见。不存在强原生轮次 ID 时，每条输入保留原参与者，不能猜测合并多人任务。远端文件与 IDE 需要可用的 Node、非交互 SSH/via 和持久 HOME，不借用 core 内部密码连接。以上限制写入功能与配置文档，不能冒充“已覆盖全部场景”。
