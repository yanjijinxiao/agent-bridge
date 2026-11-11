# 旧 App 会话分组兼容

## 已确认的入口与原因

用户截图中同一远端 odps_src_-_1 项目有“优化 ANTLR4 内存使用”和“show create table测试框架”。实际同一 App Server 的只读 thread/list 返回两条未归档会话：前者 projectId=null，后者有原生项目 ID。当前 App 注册表把两条显式归入同一个旧项目；前者没有 thread-project-membership-host-ids 同步标记，后者有。原实现把前者的 null 归为原生无项目，目录显示在“其他会话”。

本机安装 App 的代码确认：THREAD_PROJECT_MEMBERSHIP_HOST_IDS 在归属更新回调完成后记录 host；它不是工作目录推测。这个标记和当前显式 App 归属只作为旧目录展示兼容依据，不作为原生绑定或授权事实。

## 设计与实施边界

- 原生 projectId/projectMembership、线程/主机身份、执行状态及绑定继续以原生 API 为准。只在 listSessionCatalog 的展示快照中补既有 workspaceProjectId，不修改 inspectThread/listThreads 的权限或归属，不写原生数据库、项目元数据、App 注册表或永久缓存。
- 仅使用当前 App 注册表中同 host 的显式旧归属。已存在原生项目、已同步过原生归属、明确无项目/项目less、其他 host 或仅备份/目录顺序/cwd 的条目都不补回。
- 当前注册表也不是充分证据：每个现存 codex.db / codex-dev.db 必须都发布过精确 host/thread 的可见普通会话。没有 App 数据库、不一致、missing candidate 或内部来源均不补；目录查询失败保留原生行并警告。不按名字选择数据库，不合并账户，不以 App DB 替代原生发现。
- 先用明确旧别名匹配原生项目；没有别名时，仅允许已登记旧项目的完整 roots 集合与同 host 的唯一原生项目匹配，作为展示分组。两个相同根集合的原生项目不得猜选；已知别名失效不得借目录改配另一个项目。
- 项目筛选和 limit 在展示投影后处理，搜索及稳定 R 编号沿用原目录快照。无项目 unassigned 仍指原生未归属，因而可包含有旧展示分组的会话；不借展示提示重定义执行语义。已有 workspaceProjectId 文案改为通用展示分组。
- Connector 的设备目录原先再次仅按原生 projectId 过滤，会丢掉前一步已补的旧会话；现在接受同一展示 ID，并使项目筛选可跨 worktree。委派会话分支不采用展示提示，仍逐个检查精确授权线程及其原生项目。输入绑定重新 inspect 原生事实，IDE 继续要求原生 assigned 项目。
- 没有 App 注册表的 CLI 不增加查询或改分组。项目目录读取失败保留原生会话，并给出分组不完整提示。

## 四层检查范围

1. 架构：展示投影与原生身份/执行/访问隔离；同一原生 API，Connector 仍负责设备侧来源，不增加第二执行入口。
2. 模块：当前/备份 App 数据、local/remote/同 ID 跨 host、原生新归属/主动移出、唯一/歧义根集合、CLI 无 App、目录失败；目录筛选、翻页、详情和绑定的正交行为。
3. 函数/代码：逐行检查新文件的五个具名函数及内部项目登记回调、Runner 的 listSessionCatalog 投影/过滤、Connector 的 catalogCall 过滤，以及 Bridge 详情文案。只读核对 bindCatalogSession 的重新 inspect 和 Peer IDE 的 assigned 检查，保留原“原生 none 不被旧 App 赋值覆盖”反例；新增旧展示分组正例。函数正文摘要、范围与案例见同名 JSON，不宣称重审 Runner/Bridge 其余代码。
4. 静态/配置：更新 CAT-02 功能 case、模块、函数和 session 需求记录；不增加用户配置和教程步骤，不覆盖此前尚未上线的权限恢复修复。

## 验证结果

- 修改前复现：HEAD b00aa34 的 Runner 放入隔离目录，运行同一新用例，旧会话 workspaceProjectId 缺失，1 项按预期失败。日志 `/private/tmp/agent-bridge-legacy-catalog-before.tap`。
- 新增 27 项：旧分组正例；10 类不应补回的来源；明确别名/失效别名；完整多根与歧义/部分根；App 发布缺失/跨 host/内部来源；stable/dev 一致与不一致；项目筛选/limit/原生无项目；原生项目读取失败；无 App 的 CLI；后续同步退出兼容；损坏当前文件不读取备份；Connector 所有者与委派读者边界。
- 8 个相邻模块共 99 项全部通过，无跳过。真实本机 Connector RPC 使用测试自有身份和临时数据，验证项目过滤的展示字段传输；委派反例不获得项目成员身份、不提交任务。日志 `/private/tmp/agent-bridge-legacy-catalog-integration.tap`。
- 完整回归 3867 项：3766 通过、101 项按既有条件跳过、0 失败。日志 `/private/tmp/agent-bridge-legacy-catalog-full.tap`。跳过项不计为已验收。
- 桌面内置原生核心 0.167.0-alpha.3.2 的冷权限及目录回归 13 项全部通过，无跳过。测试重启的都是隔离核心，并未重启用户任务；日志 `/private/tmp/agent-bridge-legacy-catalog-native.tap`。此前 NATIVE-02.8 的 13 个函数正文摘要逐个对比未变，保留原验证来源，并补本轮组合回归证据。
- 类型检查、隔离目录编译及 diff 空白检查通过；最终编译输出到 `/private/tmp/agent-bridge-legacy-catalog-build-final/dist`，不覆盖线上 dist。完整回归后的两处注释调整不改变行为；最终来源摘要、案例/函数唯一性、日志摘要及文档入口核对通过。

真实来源只读验证：使用当前代码经既有 SSH 原生连接读取开发机 11.158.199.43。旧 ANTLR 会话与 show create table 会话都投影到 odps_src_-_1；旧会话再次 thread/read 的 projectId 仍为 null。只调用 initialize、thread/list、project/list、thread/read，未写项目归属、提交输入或读取另一主机同名文件。结果 `/private/tmp/agent-bridge-legacy-catalog-live-proof.json`，摘要见同名审计 JSON。

## 实施中发现和限制

初次只读验证遇到 stable/dev 两个 App DB：旧 Desktop 目录读取器会因无法选择数据库而拒绝。没有修改它的账户选择约束；新增帮助函数只核对所有现存目录的可见性共识。初始单元夹具误用 rootPaths 表示原生 DTO，已改为真实 roots/path 结构；失败保留在实施过程，不计为通过。

本机实际数据证明了“旧显式分组但无同步标记”这一形态，不承诺所有未来 App 私有存储版本都兼容。未知格式、目录不一致或无法唯一对应时保留原生显示；刷新会重新读当前数据。目录、注册表及原生 RPC 不是跨系统原子事务，沿用单次快照与下一次刷新机制。未验证真实钉钉投递后的视觉效果，也未把 readonly 源验证称为线上修复。

截至本记录，当前工作区同时包含此前 NATIVE-02.8 权限恢复修复；两处都尚未 commit、push 或部署，npm 正式版本仍为 0.6.2，源码版本 0.6.3 Unreleased。未改变 Gateway、Connector 或用户原生核心进程。
