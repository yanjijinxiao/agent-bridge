# 原生执行设置唯一权威检查（2026-11-05）

## 问题和约定

用户指出 `/model` 的 Gateway 持久覆盖值会盖回后来在 Codex App 中修改的模型，要求执行设置直接通过 App Server 修改。检查确认旧链路同时存在 session model/effort/plan、全局 model/effort 和网页整表提交；只删除一处读值不足以消除覆盖。

模型、推理强度和 Plan 归原生会话所有。显式命令或网页选择经同一 Connector 更新原生会话，普通输入、原生排队和 Gateway 重启不再回放执行设置。绑定、准入、来源/提交/投递回执及进度展示仍按原模块保存。旧覆盖值直接退休，不迁移成原生写入；已经在原生保存的设置不重置。

## 四层检查范围

1. 架构：Bridge/Web → 唯一后端端口 → Connector → Native；设置写入、生效确认、当前设置查询和输入提交分开。Connector 没有另一套设置仓储。Gateway 重启不替原生决定任务状态。
2. 模块：命令角色和来源守卫、未建线程时的精确身份交接、managed/paired/远程别名路由、设备 grant、旧版本能力拒绝、未知回执不重发、旧值迁移和网页字段独立提交。
3. 函数：复核 applyNativeExecutionSettings、handleModelCommand/handleEffortCommand/handlePlanCommand、updateThreadSettings、getRuntimeInfo、prepareTurnSubmission、updateSessionRuntime、normalizeRuntimeState、Peer execute/invoke、Web 读取及保存边界。函数合同中 50 个既有函数正文与改动前 AST 相同，仅更新位置/摘要；5 个既有函数只复核本次改动分支，另记录 6 个关键函数。没有把这一轮说成整个仓库重新逐行验收。
4. 静态/配置：全局网页删除模型/effort 覆盖表单，保留会话工具栏、IDE/审批/项目等其余页面；旧全局和会话字段退休；明确无项目/归属未知的 session 也覆盖；README 中英文、探探教程、功能合同、模块文档、接口表和 CTRL-06 case 同步。

## 协议发现和处理

- 真实原生 `thread/settings/update` 返回空成功响应时，设置可能尚未应用。因此等待匹配的 `thread/settings/updated` 才回复成功。
- `thread/read` 提供当前模型和推理强度，不保证提供 Plan。Plan 切换从同一原生线程 resume 的完整设置计算；只读查询缺该字段就显示未同步。
- 刚创建的空线程可能先于 rollout 索引出现；仅对明确 no-rollout 的读/附着拒绝作五秒内有界重读，设置写入不自动重试，也不伪造任务。
- 设置 RPC 超时属于 unconfirmed；不得当作未提交。原生不支持接口则提示升级，不回退成本地保存。
- Web 只提交修改字段；“当前设置”选项仅查询。模型目录显示旧值不能让进度开关重新覆盖原生模型。

## 验证

最终类型检查、JavaScript 语法检查通过。完整回归 3354 项：3266 通过、88 条件跳过、0 失败。条件跳过不作为通过计算。

另行启用真实原生测试：Mac 0.166.0 的隔离 App Server + 本机模拟模型，联合 native-thread-settings、peer-real-native、native-settings-controls 共 7 项通过。其中验证桌面客户端后改/客户端替换、忙碌轮次不被打断、完整 Connector 设置/原生查询、原权限不变及设置不生成输入。HTTP 和编排场景有受控后端；不是对真实用户会话进行测试写入。

独立临时 Chrome 配置的管理页实测 8 项通过，包括设置提交后的草稿、服务重连、Taskboard 生命周期和 375px 页面布局。另有 Web 字段隔离/空查询、三种会话归属迁移、源失效、未知回执等命名 case。Linux 已安装 CLI 0.163.0 的 schema 确认具有 ThreadSettingsUpdate 接口，并用编译后的同一制品在隔离 CODEX_HOME 下运行两项真实原生设置测试，2/2 通过（后改/重连、忙碌轮次）。初次源码测试因环境未装开发期 tsx 未能启动，改用编译产物完成；没有修改线上依赖或把未启动算作通过。

这些结果不代表所有历史 Codex 版本支持该接口，也不代表手机钉钉卡片实机验收。发布只替换 Gateway/Connector 程序；不重启用户原生核心、不更改审批策略/准入/项目绑定、不恢复已停用的头头 Linux Connector。
