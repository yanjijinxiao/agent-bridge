# 逐节点执行器

本模块是2026-11-03用户确认新增的开发范围。以下为实施合同，不能仅凭本文把33种节点标记为已实现。逐kind验收继续记入 taskboard-node-contracts.md 和 TB-10.3。

实际入口：App.tsx 的节点模式 → WorkflowBoard.tsx 保存画布 → workflow-workspace API 与 SQLite CAS → 用户运行选定版本 → 执行记录及节点结果。已有 issue-automation.mjs 是按policy启动通用AI的独立入口；它不自动代表画布执行。

## 职责

- workflow-control-flow.mjs 仍只负责合法结构。执行器遍历同一canonical树，条件只走一个分支；规划节点的子节点按保存顺序运行，不跳过挂载的子节点。
- workflow-runs.mjs 保存不可变的画布版本、触发输入、运行身份、逐节点输入/输出、错误及原生交接身份。编辑后续画布不改变正在运行的快照。
- workflow-execution.mjs 只调度和恢复。确定性条件及Taskboard数据节点使用本地规则/业务API；需要模型的节点使用同一个AiChatService和标准原生App Server。不同环境不另起业务执行分支。
- 节点执行配置在workflow-node-contracts中明确。外部API按实际提供方合同构造请求；缺少凭据、CLI或接口配置应在执行前给出具体错误，不能把“配置已保存”或泛化的AI回答算作节点成功。

## 生命周期

运行请求有客户端UUID及快照版本。重复同一请求只返回原运行；同UUID不同内容冲突。每个节点有独立固定身份。Taskboard写入与业务回执同事务；原生线程/轮次使用AiChat已有clientRequestId去重和持久原生回执。

Gateway关闭只退出观察。已经被原生服务接收的节点继续执行，重启后核对原提交，完成后才进入下一节点。无法核实的提交展示待核对，不重发；明确失败的节点停止后续步骤。用户主动停止才向精确原生轮次提交中断。

外部服务的“提交”和“任务完成”分开：有任务ID后只查询该任务；POST回执未知不得再次创建。没有查询能力的接口保留未知并展示已有信息。凭据只从执行主机的凭据配置读取，不保存在画布、日志、节点结果和IM正文。

## 验收顺序

先实现保存版本→手动运行→触发器→条件→议题写回→可见结果；再接同一原生服务的规划/Skill/MCP/开发节点；最后逐提供方接通外部接口及触发来源。每种kind分别记录实际副作用、输入/输出、失败和恢复证据。供应商实账号与手机验收不由替身测试代替。

## 当前实现与数据边界

server/workflow-local-nodes.mjs 负责触发上下文、条件和议题事务。workflow-native-nodes.mjs 负责原生 Agent 请求；workflow-command-nodes.mjs 构造精确 argv 并核验原生命令回执。workflow-http-nodes.mjs 负责 custom-api/X 的固定请求、提交前标记与输出清理。运行状态为 running/stopping/completed/failed/cancelled/uncertain，节点另有 prepared。

本次运行 API 只在设备 local 路由下，使用既有回环/Origin 边界。创建需 clientRequestId UUID、workflowId、保存 version 和 input；重复请求返回原运行。列表和读取必须匹配 projectId；DELETE 只停止指定运行。数据库表 workflow_runs 与业务库共连接；不可把网络等待放进 SQLite 事务。

浏览器提交身份在发请求前保存至本地存储；未知回执沿用原 UUID。字段错误不宣称已提交。列表返回完成状态后保留结果可见，按钮打开该节点的准确 AiChat 线程。未知旧图标使用现有 file 图标，避免整个页面崩溃。

目前云端权威数据模式拒绝节点执行，避免写入错误的本地影子库；自动触发订阅、附件归档、7 类供应商执行器仍未实现。具体 kind 逐项见 ../taskboard-node-contracts.md。用户已说明暂时没有外部服务账号，这只限制真实账号验收，不自动视为代码完成。

## 外部连接配置

设备数据目录的 workflow-connections.json（或服务 options.workflowConnectionsPath）保存 version=1、profiles 映射。每个 profile 显式指定 projectIds、kinds、endpoint 和可选 tokenEnv。画布只引用 providerProfile 名称；秘密从进程环境读取，不写入画布、运行快照或结果。X 使用固定官方地址并要求 OAuth 令牌；custom-api 只允许 HTTPS，禁止重定向与 URL 内嵌凭据。

custom-api 的 providerRequest 必须是 JSON 对象，字符串值 {{input}} 按类型替换为上游文本。提交前记录配置摘要、载荷摘要、提交时间；恢复遇 submitting 时只标记待核对，不再 POST。HTTP 202 没有任务查询适配时不能算完成。成功响应上限 1 MB，令牌字段及反射凭据清理后才持久化。

## 验证与审计

真实原生服务测试以隔离项目和模型协议夹具运行 exec_command，检查文件实际内容、原生退出码、原生 thread ID 写回；同一节点在观察端重启后只执行一次。生产 React 页面用独立 Chrome 验证手动运行、结果展示与打开准确线程。替身供应商 HTTP 仅验证请求/响应合同，不代表真实账号已验收。详细回执和未完成项见 ../../audits/2026-11-03-checklist-followthrough/。

## 发布制品

Gateway 的 dist/node_modules/codex-taskboard 固定携带 server/shared/skills/cli/scripts/dist-web；ESM 先解析该包，开发模式才使用 workspace 包。构建与回滚因此包含服务端和前端，不依赖源码目录碰巧是新版本。native-backend 的差异只在加载同一个协议适配器的代码路径，未增加执行器或连接回退。package-taskboard-runtime.mjs 对输入/输出路径做真实路径比较，包含 macOS /var 与 /private/var 的同目录情况。实际制品导入及 HTTP 静态资源/运行 API 均独立验证。
