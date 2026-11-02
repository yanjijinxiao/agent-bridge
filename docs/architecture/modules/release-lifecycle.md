# 构建、发布与 Gateway 重启

发布先在独立目录完成编译、类型/用例和静态制品准备；push 状态、准备制品、实际运行版本分别验收。release-local 的 prepare/seal/switch/verify 保留旧制品及持久发布回执，失败恢复必须解除属于本次发布的冻结，不留下永久“消息等待交接”。脚本不创建无限后台等待切换任务。

## 门禁保护范围

AccountManager 的同一 release lease 只保护 Gateway 尚在提交的原生写、审批/答案 flush、结果/媒体投递及其他实际外部交接。已由独立核心接收的任务和只读观察等待不阻止重启。systemError pending、capacity checking/settling 不能伪装成活跃写。渠道真实 write 单独持 lease，typing/读入不持。

Taskboard 借用同一个根原生端口并参与同一 release participant；freeze 同步阻止新输入/明确停止/答案提交，取消发布恢复。停止 Gateway 退休观察和本地资源，不 interrupt 原生任务、不重发已接收或回执未知输入。显式私有 stdio 仍是宿主生命周期，不能承诺 daemon 的隔离保证。

## 上线验收

核对编译 commit/sourceHash、实际新 PID、平台连接、原生 daemon PID、原 grant/ACL/endpoint、任务板服务监听 PID 与静态 index/assets 字节。只更新 Gateway dist 不代表独立 Taskboard 后端已更新；只重启也不代表前端已发布。普通 Taskboard build 会触发 Desktop 注入，不用于本次隔离发布，web 产物显式指定 outDir 后单独原子发布。

release-local、release-rollback-recovery、intent-review-release、taskboard-restart-participant、restart-handoff-boundaries 与 channel-write-leases 覆盖直接规则。安装器/Windows/真实断电和手机连通限制继续记录，不用这套脚本的通过冒充全部平台已验证。
