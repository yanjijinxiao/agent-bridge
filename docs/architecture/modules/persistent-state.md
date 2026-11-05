# 持久状态、账号与写入失败

RuntimeStateStore 是一个账号状态文件的内存写入者。账号启停、来源运行代次和资源属于 AccountManager；状态库不决定 Codex 执行终态。JSON 文件、交接 journal、原生数据库各有自己的事实，不能互相覆盖。

普通输入崩溃恢复在既有来源journal增加可选nativeInput/recoveredNativeInput事实字段，不改版本或重建去重历史。accepted恢复须精确比较原记录，追加/fsync成功后才清理正文；恢复失败回滚内存。recoveredNativeInput且phase=accepted表示尚待结果日志确认的义务，Hub保存投递事实后才记handled；两个文件间的进程崩溃由既有事实补结算，不用重发输入补偿。

## 保存与迁移

json-store 使用同目录私有临时文件、完整写入及原子 rename；要求 durable 的 journal 另做 fsync。RuntimeStateStore 保存前检查文件 revision；外部修改使旧快照刷新并拒绝当前旧写，不能覆盖别人的管理变更。磁盘提交失败重载已保存内容，调用者不得把抛错前的内存改动当作已生效。

normalizeRuntimeState 校验顶层 map/数组形状，迁移项目与会话关联，不把明确独立会话重新按 cwd 归入项目。坏 JSON/非法结构保留原文件并报告，不初始化为空状态。个人、群和会话标识均是普通数据；live dictionary 使用无原型 map，避免 __proto__/constructor 等合法键变成对象属性。snapshot/磁盘仍为普通 JSON，不改变兼容格式，也不因 map 的实现原型触发每次读取保存。

## 绑定与版本

executionGeneration 约束执行拓扑；bindingActivity 的 generation/人工活动约束过期，二者不能互相替代。rename、follow、model/effort 与原生接收身份分别保存；旧轮完成不得拿旧 session 副本覆盖新的管理设置。未知的原生项目归属既不能授权 IDE，也不能擦除已确认的关联。

## 验证边界

runtime-state、binding-expiry、account-manager 和 audit-persistence 覆盖 CRUD、迁移、外部编辑、绑定及私有文件权限。新增直接 ENOSPC 反例通过真实 store 的 setRole、leaveSession、setSessionFollow 入口注入 rename 失败，核对唯一 live owner 和磁盘均保留旧状态；不能外推所有文件系统的断电行为。特殊身份键同时验证保存、刷新和普通键对照。

## 长轮并发变更与独立清理

STATE-01.1经真实AccountManager等待原生长轮期间rename/unbind，完成后核对唯一live owner和磁盘新状态。STATE-02.3逐一注入8个资源stop/close错误；closeRunner不能因为bindingExpiry.stop抛错跳过runner.close，故分别尝试并汇总AggregateError。此处关闭的是Gateway连接，不中断独立原生任务。AUTH-01.3在已运行及停止账号均注入ACL持久化失败，manager和实际Bridge不得提前放行。

## 移除旧记忆字段

账号状态加载迁移会去掉退役的 knowledge 与 knowledgeEnabled，不再提供记忆读写 API。其余绑定、准入、回执及独立 knowledgeBases 配置保持原值；不读取或写入 Codex 原生记忆文件。动作日志仍保留历史散列用于附件去重，不把旧日志中的记忆动作恢复成业务功能。

执行设置迁移：旧 session 的 model/effort/collaborationMode 在归一化入口一律移除，覆盖有项目、明确无项目、归属未知三种会话；旧全局 config 的 model/effort 不再参与执行，并在下一次保存时退休。不能把这些旧值回放到原生会话。绑定、准入、原生接收/投递回执和展示偏好继续由各自仓储保存。见 CTRL-06。
