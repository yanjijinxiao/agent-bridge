# Herdr 源码适配四层清单

更新：2026-11-08。本文列出的开发范围已落入源码；现网发布和设备展示验收分开记录。具体 case 名称及源码/测试散列以 production-requirements.json 为准。

## 第一层：架构与事实源

| 合同 | 责任边界 | 核验 |
| --- | --- | --- |
| 唯一 Connector 入口 | 显式配置 TUI 或 App；App 使用窗口和同一固定 core；无备用执行器 | 生产 Connector 子进程、错误 core、旧配置兼容、端点替换 |
| 共享业务不分叉 | 授权、目录、文件、共享、IDE、卡片仍为一套；适配器只转换上游语义 | 两运行类型参数化 RPC/Bridge；App 实际远端文件和 IDE |
| 终端不是原生 turn | 17 项 operation、57 个 facade 端口、5 个 runtime RPC；screen 不执行动作 | 类型穷尽、畸形/伪造回执、屏幕动作转义 |
| 持久状态职责 | Connector 交接与生命周期；Gateway 来源、只读观察和投递；Herdr 执行状态 | 丢确认、落盘失败、重复来源、双方重建、SIGKILL |
| 重启独立性 | 短锁保护交接，不覆盖远端任务；重连只读核对原资源 | 真 Connector SIGKILL 后两端继续，未知不重发 |
| 权限和操作正交 | 配对身份、资源归属、文件范围、渠道呈现、业务能力分别检查 | 换绑/撤权/多 actor 多群、无 cwd、设置与 stream、共享访客 |

## 第二层：模块和场景

| ID | 功能 | 用例与实际边界 |
| --- | --- | --- |
| HDR-01 | 配置与版本 | connector-runtime-config/process、runtime-versions；头头/探探与相关 Connector 同一制品已上线并核验 |
| HDR-02 | 目录与项目 | agent-runtime、herdr-app-layout、runtime-channel；空项目、歧义、无 cwd、目录与绑定一致；远端完整性保守显示 |
| HDR-03 | 配对及身份 | agent-peer、runtime-observation；原账号/聊天/用户、固定资源、委托隔离；真实多人跨群另验 |
| HDR-04 | 输入交接 | agent-handoff、agent-peer、live-connector；持久意图、重复/未知/SIGKILL、不重发 |
| HDR-05 | 只读回执 | runtime-channel/observation、inbound-receipts；原来源指纹，丢确认、写盘失败和双方重建 |
| HDR-06 | 画面读取 | agent-runtime/peer、runtime-web/observation；读前后身份和换绑核对，文本不执行 |
| HDR-07 | 中断和并发 | 两 adapter、runtime-lifecycle；共享短锁，App 请求及 TUI 显式单键；两端实际验证，非全部 agent 证明 |
| HDR-08 | 协议与 checkpoint | JSONL/UTF-8/UUID/帧长、坏响应、递归 checkpoint schema；故障语义不降级 |
| HDR-09 | 普通 IM 与卡片 | runtime-channel/observation、stream-checkpoint、live-connector；原卡、IDE、复制、状态、@；真实探探已验；移动端另列 |
| HDR-10 | 文件、共享和完整 IDE | runtime-file-host/sharing-ide、peer-files/ide；1 MB 字节、远端主机、撤权/目录变化、socket/HTTP/WS；App→Linux 实际文件与 code-server HTTP |
| HDR-11 | 命令正交性 | runtime-command-policy/channel/web；36 命令、22 别名，catalog/binding/record/gateway 分流；缺能力不屏蔽整模块 |
| HDR-12 | 清理 | connector-cleanup/process、runtime-file-host；逐资源失败仍清理其余，握手失败退出；不停止独立任务 |
| HDR-13 | 创建/命名/关闭 | runtime-lifecycle/channel、两端实际生命周期；多步中间资源、部分失败、未知不重放、最小修改范围 |
| HDR-14 | 跟随及参与者 | runtime-observation/channel、live-connector；stream/follow/输入义务独立，撤权与多来源重建；无原生 turn 不猜合并 |
| HDR-15 | Web 与 Taskboard | runtime-web/web-native-settings、Taskboard catalog/runner/workflow；能力前置、 managed route、普通说明/CRUD、结构化节点拒绝 |
| HDR-16 | 既有 Codex | 57 端口显式分类与完整主库/Taskboard回归；原生设置/审批/queue 不迁为终端操作；默认跳过另列 |
| HDR-18 | 终端展示 | 稳定阶段、bounded 活动、composer 与旧输入去除、命令摘要、段落和 IDE；真实卡片确认 |
| HDR-19 | 原生审批完整性 | 接受回调屏障、实时 fileChange 关联、重连有界读取、缺失/截断明示；真实审批续卡 |
| HDR-20 | 旧 host 冷启动 | local/remote-ssh-discovered/peer 三组合；绑定与订阅保留，未知能力不伪装；实机回退、隔离失败及重新上线证据 |
| HDR-17 | 恢复事实隔离 | inbound-receipts/channel/web；runtimeInput 不进入原生 turn/queue 恢复，原 actor/chat/binding 固定 |

这些是可审查的功能合同，不是把每个底层测试都当作整组集成通过。700 个选定用例包含共享既有测试；总数不代替反例和设备边界。

## 第三层：函数与代码

新增 runtime/host 模块按完整控制流检查，65 个改动源码/脚本文件分别登记完整模块或局部调用者阅读。共享大文件如 BridgeService、AccountManager、Web、AiChat 只登记本次修改函数及调用边界；wholeRepositoryReviewed=false。

重点核对 prepareWrite 异步来源验证之后的目标重读、最终同步 guard、磁盘先于外部写入、来源与指纹唯一性、写入未知、App 布局成员与文件主机身份、文件/IDE 租约复验、只读观察与操作命令分离。函数职责已写回 modules/agent-runtime.md，不使用只有测试名的“检查完成”记录。

发现的三项文件作用域反例有独立失败复现和修复后记录。Node HOME、远端临时目录问题有实机错误与修复结果；夹具错误另列。原有 EPIPE、目录歧义及终态重试证据保留在历史检查点。

## 第四层：静态、配置、文档与构建

- Connector 严格配置、原生/运行协议版本字段、旧配置兼容、静态命令表、端口表与 Web/Taskboard 能力展示核对。
- README 中英、探探现网教程、Herdr 配置说明、架构/功能/模块/命令/实机/剩余工作同步；历史阶段仍保留日期与范围，不替换旧散列冒充新验证。
- Herdr 配置说明纳入 npm 打包文件清单；不改变产品版本，候选配置与生产配置分开，不输出设备凭据。
- 根目录与 Taskboard typecheck 通过；独立临时构建、静态资源、两个编译后 CLI help 通过；npm 已有 3 项用例补验通过。
- 通过发布脚本封存制品并统一上线头头/探探及相关 Connector；既有绑定、浏览器授权和独立原生进程已核对。源码已推送，npm 未发布；见 deployment-verification.json。

真实探探平台往返、Gateway/Connector 骤停及 Codex CLI/App 兼容已补验；主机断电、真实多人跨群和移动布局另列。Herdr 原生没有的结构化合同属于能力边界；二者都不能冒充代码已缺省实现。
