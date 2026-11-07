# Herdr 实机测试环境

核对日期：2026-11-07。按时间保留安装、底层与业务验证检查点；最新结果在文末，早期的“未验证”不是当前待办。源码适配已完成列明范围，现网未切换。

## 环境职责

| 环境 | 用途 | 本次确认 |
| --- | --- | --- |
| 11.158.199.29，SSH admin / 49187 | 探探 Gateway、跨机渠道验证 | SSH 可登录，测试目录可写；tantan-gateway-test 运行中，本次未改动 |
| 11.159.100.12，SSH admin / 49178 | Herdr TUI、Linux Connector | TUI 0.9.5 已安装，独立测试服务可查询；原 Connector 保持运行 |
| Mac mini | Herdr App、桌面环境验证 | App 0.1.13 已安装并打开，窗口 status 接口返回 errors=[] |

## Linux TUI

- 启动命令位置：/home/admin/bin/herdr。
- 专用测试会话：agent-bridge-test；使用 herdr --session agent-bridge-test 进入此会话。裸 herdr 使用原默认会话，不是本次测试目标。
- 测试 socket：/home/admin/.config/herdr/sessions/agent-bridge-test/herdr.sock。
- 本次 status 确认为 0.9.5；private_protocol=22；endpoint 和 private protocol 兼容检查均通过。private_protocol 是观测值，不作为公共 API 稳定性保证。
- api snapshot 成功，agents/workspaces/tabs/panes 均为空；没有启动 agent 或发送模型任务。
- 默认会话仍运行 0.8.2。本次没有热切换或停止旧服务器；旧客户端备份：/home/admin/.local/share/agent-bridge/herdr-backups/herdr-0.8.2-20261107。
- 测试服务日志及 PID：/home/admin/gateway-connector-linux-test/herdr-tui/。本次以后台服务启动，未配置系统重启自启。
- Linux 原证书库无法验证 GitHub 下载链；改由 Mac 正常 TLS 下载官方二进制、两端校验 SHA-256 后传入，未关闭证书验证。官方文件 SHA-256：14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d。

## Mac App

- 应用：/Users/xking/Applications/Herdr.app；命令：/Users/xking/.local/bin/herdr-app。
- bundle ID：dev.herdr.app；版本 0.1.13。官方安装器完成下载校验，codesign --verify --deep --strict 通过。
- 应用已打开至初始欢迎界面；status 返回空 space/tab、frame-welcome、errors=[]。尚未创建工作区或 agent。
- 配套 core 仅作为 App 依赖安装。用户明确要求不单独配置或测试 core；本次没有单独的 core 接入验收。
- App 的窗口控制接口与 core 的终端执行接口不同。后续以 Herdr App 整体使用链路验收，界面布局与任务执行分别取真实证据。

## 安装阶段验收边界（历史检查点）

已验证下载完整性、二进制可执行、TUI 专用服务与快照读取、App 签名与窗口启动。未执行 Herdr agent 输入/输出、中断、重连、Gateway 适配或真实钉钉往返测试，也没有更新或重启头头、探探、Connector、Codex 原生执行器。

后续实测以 29 的探探、12 的专用 TUI 会话和 Mac 的 App 为明确目标；禁止将旧默认 TUI 会话误当测试实例。服务版本、公共方法表与实际 agent 能力需要重新读取并记录，不能以源码调研或安装成功替代业务场景验收。

官方安装来源：[TUI](https://github.com/herdrdev/herdr#install)、[App](https://github.com/herdrdev/herdr-app#install)。

## 2026-11-07 底层适配实测增量

本节更新上面的安装检查点；不把“当时尚未创建工作区”继续当作现在的状态。

### 12：TUI 真实 Codex CLI

使用专用 agent-bridge-test 服务，新建名为 Agent Bridge adapter validation 的隔离 workspace，工作目录为 /home/admin/gateway-connector-linux-test/herdr-tui/fixture。通过公共 agent.start 启动 Codex CLI 0.163.0，仅提交无工具、无文件读写的固定回复测试。

- 适配器按稳定 terminal_id 查找当前 pane 后 prompt，收到 terminal-written；没有编造 turnId。
- 实际状态从 idle 到 working，再回到 idle；屏幕包含预期 HERDR_BRIDGE_TUI_OK 回复。
- 第二个独立测试使用持久交接模块：确认写入后关闭 Bridge socket，重新创建适配器与日志对象；重复同来源只返回已有回执，再读取到 HERDR_HANDOFF_TEST_OK。该次读取时状态检测仍可能是 working，故报告仅确认预期回复可见，不把它写成业务成功终态。
- 真实测试先暴露了 EPIPE：TUI 普通 API 每条请求后关闭连接。已改为每请求一条连接，并保留直接回归；不是发送失败后自动重试。
- 测试产物及证据留在测试目录，未修改原 Connector、默认 0.8.2 服务或用户原会话。本轮 workspace 在空闲且 ID、目录与名称一致后关闭，测试服务保留。

### Mac：Herdr App 真实终端 fixture

App 0.1.13 使用其现有 core 0.1.18；配置固定 core.id，未启动另一套 core。通过 App 自身 space.new 创建隔离测试空间，运行 Python 回显程序，以 OSC 7501 报告 idle/working/blocked。

- 从窗口读取 space/tab，和同一 core 的终端记录按地址关联；读取到正确 cwd 和状态。
- 普通输入返回 terminal-written/started=true，实际屏幕包含对应 FIXTURE_RECEIVED；稍后状态回到 idle。
- fixture 切为 blocked 后，普通消息在适配器中明确 not-sent；实际画面确认没有 MUST_NOT_BE_WRITTEN 字样。
- 最终源码再次验证 blocked 拒写与原回显；仅关闭本轮创建、ID/目录/终端均匹配的测试空间。App/core 继续运行。

这验证的是 App 产品链路的实际 PTY 和状态报告，**不是 Claude Code 或其他 agent 的完整集成测试**。App 原生 interrupt 目前只有协议回归测试，未宣称实机通过。

### 仍未验证

探探/头头经生产 Connector 的 Herdr 命令与钉钉往返；Gateway 实际重启恢复 Herdr 卡片；App attach 事件流和 TUI events_lost；远程 machine 文件/IDE；全部 `/help` 操作与工作流；手机呈现。具体接线改造见[设计](herdr-adaptation-design.md)。本轮没有更新、重启或发布任何生产 Gateway/Connector。

### 生产接入源码复核后的只读检查

Mac 配置的 App/core 仍可读取：core 0.1.18、generation 1，目录 0 个项目、1 个终端、0 个已核实目录根；当前没有非空空间，不能据此声称新布局成员交叉核验已实机通过。Linux 12 专用 TUI 返回 pong 0.9.5，snapshot 为 0 workspace/agent；默认旧服务未改。

此次 Linux 临时探针最初传数字请求 ID，被公共 API 判为 invalid request；改用字符串后正常。产品 JsonLineClient 原本就使用字符串 UUID，因此该次是探针错误，不是适配器修复证据。

生产入口、普通消息、回执恢复及卡片新增功能已做隔离 WS/JSONL/IM 驱动验证，未将此结果冒充上述两台真实环境的完整往返验收。

## 2026-11-07 完整业务验证检查点

本节取代上述阶段的待办状态。测试未重启头头、探探、Codex 或原 Connector，也未修改现网配置。使用真实 Herdr、隔离 GatewayPeerServer、生产 Connector 入口子进程及真实 BridgeService；IM 渠道使用捕获适配器。

| 场景 | 实际结果 | 不能据此证明的范围 |
| --- | --- | --- |
| Linux 12 TUI 生命周期 | 公共接口创建 workspace、启动真实 Codex CLI、命名、关闭原 pane | 不代表所有 agent 的启动参数 |
| Mac App 生命周期 | 原 App/core 创建、命名、关闭目标终端；独占 tab 范围检查 | 不代表所有 App 布局组合的 UI 验收 |
| TUI 中断 | Codex 工作中发送显式配置的 Esc；先收到 still-working，随后观察 idle | 不把键入确认当作任务取消 |
| App 中断 | OSC 7501 测试程序报告 working；原生 interrupt 返回 stopped，随后观察 idle | 实际 PTY 测试，不冒充 Claude 等全部 agent |
| App → Linux 12 文件和共享 | 1 MB 二进制 SHA 校验往返；共享读写、旧 hash 冲突拒绝 | 不代表供应商 IM 附件投递 |
| App → Linux 12 完整 IDE | 真实 code-server 4.141.1 的 health 和 workbench HTTP 均为 200 | WebSocket 1 MB 字节中继另有隔离测试；未做实机 IDE Git/终端 UI、手机验收 |
| TUI 普通 IM 输入与断连恢复 | 真 Codex CLI 收到输入；SIGKILL Connector，重建 Connector 及 Gateway 观察对象，恢复原画面和 IDE 入口，原来源只通知一次 | 未 SIGKILL 线上 Gateway；无真实钉钉发送 |
| App 普通 IM 输入与断连恢复 | 真 PTY 的 received.txt 证明输入仅一次；SIGKILL Connector 后按原资源恢复 | App 使用测试程序，不代表其他 agent 的完整工具行为 |

最后两项为可重跑的 test/herdr-live-connector.test.ts，最终同一源码散列的两项均通过。实际运行依赖明确配置的测试 socket；默认回归跳过，单独启用后留存结果，不能把默认 skip 算作通过。

实机暴露并修复两类部署问题：容器 Node 包装器将 HOME 重置为 /，不同 helper 的 /tmp 不共享。现仅在固定 helper 中恢复所选登录账户 HOME；远端 IDE socket 保存在账户持久目录，校验权限/所有者/符号链接，等监听完成才返回。文件传输另补资源范围变化的三项隔离失败复现。测试脚本自己的参数、OSC 格式及退出清理错误单列，不计为产品缺陷。

清理：仅关闭本轮创建且身份、目录匹配的终端/空间；移除测试 machine profile bridge-linux12；通过 PID、命令和独立 XDG 路径核对后停止该 profile 的两个远端测试 core/holder 进程；临时 SSH socket 中继已停止。Linux 专用 TUI 测试服务和测试目录的依赖二进制保留复用。默认 0.8.2 TUI 与生产 Connector 未动。

证据摘要、精确用例与散列集中在 [四层报告](../audits/2026-11-07-herdr-adapters/README.md)。原始运行日志位于测试机临时目录；持久报告保留日志摘要和散列，不包含设备凭据。

## 2026-11-08 真实探探与浏览器增量

以上均为按时间保留的安装/隔离检查点。最新已完成两端真实探探 IM、Gateway/Connector 骤停、附件合并及卡片；Mac/Linux 浏览器编辑保存、Git、终端和刷新重连也已通过。原 Codex CLI/App 新建测试线程完成读写、审批、附件、steer、queue、停止与运行中双进程重启，原生执行器未重启。见 [真实验收](../audits/2026-11-07-herdr-adapters/acceptance-2026-11-08.md) 与 [Codex 兼容](../audits/2026-11-07-herdr-adapters/native-compat-e2e.md)。

2026-11-08 最终部署：头头/探探 Gateway、Mac/Linux 原生 Codex Connector 与两种 Herdr 测试 Connector 均为 a8e4a72。Gateway 为独立重启，Mac Codex PID 23722、Linux Codex PID 9955、Herdr App/core PID 85344/85378 保持。头头 28 个浏览器授权与两端原绑定保留；见四层报告中的 deployment-verification.json。
