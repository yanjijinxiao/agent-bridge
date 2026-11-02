# IM任务事务回执与远程结果回传

本轮沿原剩余工作继续开发。没有真实IM发送、真实云业务写入或桌面任务重启。历史TB-09.5反例保留；当前修复结果只覆盖下述实际范围。

## 架构与职责

Gateway只记录来源和交接阶段，Taskboard数据库提供写入事实。表单ID按账号/对话/actor隔离，完整载荷另做fingerprint；先保存Gateway pending，再经既有任务API传clientRequestId。业务写与接受回执同事务；查询为空不等于未接收，仅能带同一身份安全重试。创建Task不等于Codex已接收；未知执行不重发，明确CodexRunAdmissionError未提交才可恢复pending。其他表单不受该未知请求阻塞。

远程文件端口属于执行主机路由层。固定只读脚本通过已选择SSH传输读取，Gateway校验长度/SHA256后取得私有副本；Bridge在异步下载后复核绑定/服务状态，再调用有该媒体能力的渠道。结果动作原有started/done日志仍决定未知渠道发送不重放。没有把远端路径交给本机直接读。

## 模块和异常场景

- Gateway交接：真实Bridge→Controller→TaskboardClient→隔离HTTP/SQLite；提交后丢响应，同表单重试和Gateway/Taskboard双重启均只1次创建POST、1条任务。journal记录原生workflow未知/已明确未提交的差异；不同来源独立，异载荷拒绝。
- 服务端事务：SQLite与Miniflare D1并发创建、评论、状态变更；CAS失败无接受回执，删除实体后仍保留回执，不再次创建。注入SQLite回执INSERT失败，业务Task及编号同时回滚。
- 兼容迁移：旧数据库/旧迁移包可没有task_submissions；新回执随快照、文件包和D1导入计划保留。新D1须先应用0002迁移。旧API严格拒绝clientRequestId，不静默忽略后执行写入。
- 远程字节：隔离SSH替身执行实际脚本，原始文件名及二进制、0600权限、私有目录清理；拒绝符号链接/非文件/超限、坏摘要、超时/异常输出。真实Bridge下载途中换线程后0发送；本机同名文件原字节未被发送。

## 文件和底层函数

按本轮diff逐项复核，并仅对逐字不变的旧读区间继承原审计记录；新实现、SQL迁移、测试、配置辅助与模块文档单独记入read-ledger。selected function contracts补录journal、HTTP派生客户端、SQLite/D1事务、迁移和远程字节端口；未宣称全仓所有函数都具备独立场景。

SQLite业务原语保留单独调用的BEGIN IMMEDIATE语义，仅在外层提交事务中改用SAVEPOINT，不让内部COMMIT提前提交回执。D1的唯一回执冲突回滚整批，失败CAS不由0写入生成回执。回执保留目标ID，不要求已删除实体必须仍存在。

## 静态文件与配置

本轮没有修改网页布局或静态资源；新0002 SQL、Cloud测试迁移加载顺序、严格输入元数据和模块/功能说明一同复核。无UI变化，因此不以构建代替手机视觉验收。

## 检查结果及实际边界

最终测试结果由test-results.jsonl记录精确名称及文件SHA。Gateway全量带独立Chrome和原生二进制运行；Windows专用项仍在本机跳过。Taskboard全量包含隔离Chrome与D1；两端TypeScript检查通过。

开发期间的失败夹具也已修正：D1 exec按行执行不接受多行单条SQL，迁移验证改用实际参数化batch；SQLite行对象的null prototype不应被误判成数据不同；非超时场景不再使用100ms进程启动预算。上述修正不作为产品通过证据，最终报告以完整成功运行记录为准。

未完成：真实远程主机与供应商IM/手机联调、真实原生接收与Gateway落盘间骤停后按原turn自动核对、无request_id旧文字命令的跨消息幂等、Web历史下载远程附件。Workflow33种节点执行器、渠道能力差异、npm原子更新及LinuxARM64自动安装继续列在remaining-work，不宣称已完成。
