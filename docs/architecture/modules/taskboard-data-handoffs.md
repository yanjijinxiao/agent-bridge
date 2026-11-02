# Taskboard 表单、附件和页面回执

本说明覆盖实际 React 表单到 HTTP 数据写入、确认后的 UI 更新。议题/评论是 Taskboard 的数据实体；原生 Codex 线程和执行另有权威，不能把创建议题回执当作原生任务接收。

## 入口及事实归属

| 入口 | 操作链 | 事实源 |
| --- | --- | --- |
| 新建议题 | TaskEditor.handleSubmit → App.saveEditor → api.createTask → /api/tasks → 本地SQLite或云D1 | 服务端Task实体及version |
| 评论 | TaskDetail.submitComment → api.createComment → /api/tasks/:id/comments | 服务端Comment实体及version |
| 附件 | 原实体创建后逐文件POST，图片再PATCH正文中的精确资源URL | 服务端Attachment ID与原实体归属 |
| 副本/归档/撤回 | App中的具体操作 → 版本化API → 原实体更新 | 服务端返回的Task，不是列表当前选择 |
| 页面投影 | App的selectedProject、project view generation与请求序列 | 当前浏览器视图，不授予服务端权限 |
| 浏览器交接记录 | submissionReceipts.ts，kind/scope/operation ID一条key | 仅本地操作是否仍待核对；不含正文或File数据 |

本地/server与cloud API均须保留实体版本与附件归属。当前此轮修改在浏览器编排层，不修改生产数据库，不自动改变权限或原生执行设置。

## 新建和评论的阶段

1. 保存操作ID及创建阶段记录。保存失败则不发创建请求，正文与文件仍在原表单。
2. 创建返回准确实体后，保存实体ID。此后重试只能续用该实体，不再create。
3. 对每个File保存已确认Attachment。部分明确拒绝保留失败文件和原实体，继续时跳过成功文件。
4. 内嵌图按原token顺序替换成精确附件URL，使用当前确认版本PATCH原正文；与普通附件回执分开。
5. 全部完成只移除本操作的记录，更新原视图。评论仅在原草稿revision未变化时清空，组件owner变化后不能清除新组件的草稿。

TaskEditor与评论使用同步提交ref，不能只依靠按钮disabled或React下一次render挡住重复提交。表单展示“继续保存议题”或“继续本次提交”时，它继续原实体的附件/正文处理。

## 明确拒绝、未知与页面关闭

创建前明确4xx拒绝没有实体，保留表单并允许用户重试；创建已确认后的明确拒绝保留原实体和文件回执。网络错误、5xx、坏成功响应或版本冲突不推断为“未应用”，保留记录并要求核对已有实体，禁止自动重发。

File对象仅保存在当前表单内存；页面关闭后不能宣称文件内容可自动恢复。下次打开仍保留不含正文的未完成记录，先核对服务端实体。结束本次提交只退休快照中那几个本地操作，不删除议题/评论、不撤销已应用的HTTP修改，也不清掉稍后创建的另一个操作记录。

同一scope的多个表单分别拥有操作ID和独立key，避免一个表单成功清掉另一个未知提交。读取记录不可用不能当作已退休。浏览器记录不替代后端通用幂等键；Gateway渠道命令的跨重启未知写去重仍需独立解决，不能从本UI记录外推。

## 项目视图的生命周期

所有项目选择、初次恢复和浏览器popstate共用selectProjectView。选择事件内同步推进代次；A→B→A不会复活A的旧回调。变化时退休旧列表读取、菜单、编辑器和撤回栈，原后端写继续对原实体生效。

成功、失败、finally和撤回回调在修改当前页面前核对原view。原操作确认不能插入新项目列表、安装旧撤回、显示旧错误或抢回项目选择。已有实体修改回执仍返回给原调用者；离开视图不伪称原写未提交。撤回的pending归属也按view代次分开，旧view等待不锁新view。

同项目其他实体的列表事实可正常更新，服务端权限由API校验；浏览器视图lease不能替代授权。

## 验证范围与未完成项

实际Chrome运行生产App/TaskDetail/TaskEditor、React与CSS，HTTP为可延迟/拒绝/丢回执的替身；没有真实用户任务写入。直接场景包含普通/内嵌附件部分失败、创建未知跨刷新、组件卸载/重挂的草稿、双表单独立回执，以及4种App操作×正常/换项目/ABA。原失败及夹具错误保留在completion-worklog.md所列日志，case已映射至TB-03.4、TB-09.1/.2/.4，含配额故障初次提交与已确认续传对照。

这不代表云端所有未知写、R2补偿或手机端已验证。工作流和现已完成的原生 AI 执行分别见独立模块说明；AI HTTP 幂等也有自己的 UUID/事务合同，不能从普通议题/评论的浏览器记录外推。

## IM表单的持久交接与事务回执

入口是TaskboardChannelController.submit，经TaskboardClient.withSubmission到原有POST任务/评论/move/transition API。表单request_id按账号、对话、actor生成独立身份；同ID换项目或载荷拒绝。Gateway在每账号taskboard-submissions.json中先durable保存pending，再发HTTP，成功记录completed；重启后未确认操作先GET /api/task-submissions/:id核对。

服务端用独立fingerprint绑定操作路径、actor与完整请求体。SQLite在BEGIN IMMEDIATE中执行业务SAVEPOINT与回执INSERT；D1把业务与唯一回执放在同一batch，竞争回执冲突回滚本批业务。失败CAS不记accepted。回执不随Task/Comment删除，避免删除后再次创建；精确重试不重复发事件或触发自动化。云迁移可选携带task_submissions，旧数据库/旧包无此表仍按原数据迁移。云端启用新接口前须应用0002_task_submissions.sql；旧后端严格拒绝clientRequestId，而不会忽略它后写入。

未知HTTP结果不删除操作身份；重试只读核对已提交实体。若读回执仍为空，只允许携带同一服务端幂等身份重试，不由“查询为空”推断此前未提交。TB-09.5用实际Bridge→HTTP→SQLite丢响应及双重启验证；SQLite/D1并发、失败回滚、删除后回执与迁移都有直接检查。

“创建并开始”分为Taskboard写入与Codex执行交接。进入原生调用前单独持久记录workflow，未知结果只提示查看原会话，不把创建成功当作执行已接收，也不自动重发。真实原生交接中骤停后按原turn自动核对尚未验证，单列TB-09.6 partial；这不阻塞其他请求。无request_id的旧文字命令不承诺跨消息幂等。完整剩余工作见../remaining-work.md。
