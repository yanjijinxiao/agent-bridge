# Taskboard 节点配置与执行对照

2026-11-04 范围调整：用户明确表示无需继续开发上一条列出的功能。7 类供应商适配、工作流自动触发、云端工作流写回、流程产物归档退出当前开发与验收范围；保留实际实现/缺测记录，不改成已完成。后续仅凭当前清单不得重新启动这些开发。已有功能的缺陷及 Linux 沙箱环境限制仍按事实记录。

2026-11-03 逐节点执行阶段。真实入口：App 节点模式 → WorkflowBoard 保存 CAS 版本 → WorkflowRunPanel 手动运行 → /api/local/workflow-runs/:projectId → WorkflowExecutionService → 节点回执/结果区。编辑、保存和执行是不同动作；保存画布不会产生外部副作用。

本轮共 33 kind：8 个本地节点、7 个原生 Agent 节点、9 个命令适配节点、2 个 HTTP 节点已接执行路径；7 个外部供应商适配器仍未实现。已接通不代表已完成所有真实账号验收。TB-10.3 仍是 partial，不能把账号暂缺掩盖成全部代码已完成。

| kind | 配置要求 | 实际执行入口 | 已验范围与剩余边界 |
| --- | --- | --- | --- |
| issue-trigger | 当前项目的未归档议题；可限制状态 | 本地读取议题及原始触发上下文 | 手动运行已验证；画布尚未订阅议题事件 |
| rss-trigger | feedUrl；手动事件 kind/feedUrl | 校验本次事件，向下游传递文本 | 手动注入；没有 RSS 轮询器 |
| pull-request-submitted-trigger | 匹配 kind 的手动事件 | 校验本次事件并传递 | 没有 GitHub webhook 订阅 |
| repository-issue-submitted-trigger | 匹配 kind 的手动事件 | 校验本次事件并传递 | 没有仓库议题 webhook 订阅 |
| git-status-trigger | 匹配 kind 的手动事件 | 校验本次事件并传递 | 没有目录监听/自动轮询 |
| condition | 字段、操作符、比较值 | 确定性规则；只走 true/false 中一个分支 | 本地真实 SQLite 分支及后续副作用已验 |
| skill | 当前原生目录中的 selectedSkill | AiChat skillIds → 同一原生 App Server | 目录校验已接通；真实用户 Skill 副作用尚未逐个验收 |
| mcp | 当前服务目录 ID；additionalInstructions | 同一原生轮次中的选定 MCP 服务任务 | 目录校验已接通；具体工具授权/结果需逐服务验收 |
| nano-banana | 待具体供应商/模型合同 | 未实现供应商适配器 | 不是凭据已填即可运行 |
| jimeng-image | 待具体供应商/模型合同 | 未实现供应商适配器 | 不能将通用 AI 回复当作图片生成 |
| midjourney-image | 待用户指定获授权的接口 | 未实现供应商适配器 | 不假造官方 API，不调用非授权转售接口 |
| seedance-video | 待具体供应商/模型合同 | 未实现供应商适配器 | 异步任务 ID/轮询/产物合同待实现 |
| kling-video | 待具体供应商/模型合同 | 未实现供应商适配器 | 异步任务 ID/轮询/产物合同待实现 |
| custom-api | 项目授权的连接 profile；JSON 对象 | 固定 HTTPS POST；typed {{input}}；保存回执 | 替身 HTTP 已验；真实外部账号暂缺；202 不算完成 |
| git | 操作及必需的分支/提交说明/路径 | 原生工具执行精确 argv；顺序核对退出码 | 8 种命令计划已实现；原生执行框架已验，Git 全操作另测 |
| feishu-docs | 待目标文档、权限及提供方合同 | 未实现供应商适配器 | 不把配置保存当作创建文档 |
| feishu-message | 接收者类型/ID | 未实现供应商适配器 | 不发送真实消息，未接通成员身份解析 |
| twitter-post | 项目授权的 OAuth profile；正文 | 固定 X /2/tweets；必须收到 data.id | 请求/回执替身已验；未发布真实推文 |
| opencli | integrationArguments JSON 字符串数组 | 原生工具执行 opencli argv | 命令计划已验；本机未安装 CLI |
| claude-design | 说明；可选模型 | 原生工具执行 claude -p --output-format json | 命令计划已验；本机没有 Claude CLI/账号 |
| cloudflare-deploy | 显式 Wrangler 配置路径 | 原生工具执行 wrangler deploy --config | 命令计划已验；未对真实 Cloudflare 项目部署 |
| vercel-deploy | 已链接 .vercel/project.json；可选 production | 先校验项目/org，再执行 vercel deploy | 命令计划已验；未对真实 Vercel 项目部署 |
| custom-integration | 含可执行文件的 JSON argv | 原生工具执行精确命令 | 依赖执行主机工具/原生审批；不注入绕过审批参数 |
| custom-code | shell/javascript/python 与代码 | 原生工具调用对应解释器，代码为单独 argv | 真实原生 exec_command 写临时文件及退出码已验 |
| write-tests | 节点说明/上游需求 | 同一原生服务编写测试 | Agent 节点已接通；具体代码改动按原生结果检查 |
| run-tests | 范围；自定义范围必须填命令 | 自定义精确命令；其余范围由原生服务选择 | 自定义命令检查工具回执；非自定义属于 Agent 结果 |
| basic-planning | 上游上下文 | 同一原生服务输出计划，子节点由调度器执行 | HTTP → 原生替身 → 议题写回全链路已验 |
| claude-code-planning | 需求；可选模型 | claude -p + permission-mode plan | 命令计划已验；没有真实 Claude CLI 验收 |
| custom-planning | additionalInstructions 必填 | 同一原生服务输出用户指定计划 | 不代替调度器执行后续子节点 |
| issue-create | 标题；状态/优先级/标签 | 本地业务事务及唯一业务回执 | 真实 SQLite 一次创建及回执恢复已验 |
| issue-update | 至少一项写回动作；目标议题 | 本地同事务修改/评论；可关联原生会话 | 真实 SQLite/原生写回已验；attachArtifacts 尚未实现并明确拒绝 |
| codex-review | 上游上下文/说明 | 同一原生服务审查，不主动改代码 | Agent 节点已接通；具体审查结论另行判断 |
| claude-code-review | 说明；可选模型 | claude -p + permission-mode plan | 命令计划已验；没有真实 Claude CLI 验收 |

## 共同合同

- 固定保存版本、输入和节点身份；同 UUID 同输入核对原运行，不创建新任务。后续画布编辑不改运行快照。
- 本地业务写入与去重回执同事务。原生提交复用 AiChat 的持久回执；关闭 Gateway 不中断原生轮次，恢复只接回原轮次。
- 原生命令节点必须有 core 的 command_execution 成功回执；模型声称成功不足以进入下一节点。
- 外部 POST 先持久化 submitting。响应未知、202 或无法确认完成时保持 uncertain，不重发、不运行后继。显式停止仅停止后继，不声称撤销已发送动作。
- 云端 Taskboard 权威数据执行尚未适配；配置 remoteUrl 时明确阻止运行，不写影子本地库。4 类外部触发器尚未自动订阅。产物附件写回尚未实现。
- 执行中的原生审批沿用 AiChat；运行结果可打开准确线程。没有另一套桌面/headless 业务分支。

实现职责与连接配置见 modules/workflow-node-execution.md。覆盖入口见 taskboard/test/workflow-*.test.mjs、test/workflow-native-execution.test.ts、test/workflow-browser-execution.test.ts、test/gap-taskboard-contracts.test.ts。外部账号和手机实机状态单独记录，不由替身结果代替。
