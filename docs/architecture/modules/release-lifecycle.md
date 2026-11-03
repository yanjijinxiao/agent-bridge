# 构建、发布与 Gateway 重启

发布先在独立目录完成编译、类型/用例和静态制品准备；push 状态、准备制品、实际运行版本分别验收。release-local 的 prepare/seal/switch/verify 保留旧制品及持久发布回执，失败恢复必须解除属于本次发布的冻结，不留下永久“消息等待交接”。脚本不创建无限后台等待切换任务。

## 门禁保护范围

AccountManager 的同一 release lease 只保护 Gateway 尚在提交的原生写、审批/答案 flush、结果/媒体投递及其他实际外部交接。已由独立核心接收的任务和只读观察等待不阻止重启。systemError pending、capacity checking/settling 不能伪装成活跃写。渠道真实 write 单独持 lease，typing/读入不持。

Taskboard 借用同一个根原生端口并参与同一 release participant；freeze 同步阻止新输入/明确停止/答案提交，取消发布恢复。停止 Gateway 退休观察和本地资源，不 interrupt 原生任务、不重发已接收或回执未知输入。显式私有 stdio 仍是宿主生命周期，不能承诺 daemon 的隔离保证。

网页 npm 更新入口也遵守同一归属：安装后异步启动重启助手必须把成功/失败回传给持有 release lease 的 HTTP 层。启动失败应释放本次 lease，保留当前 Gateway 服务；不能只在后台打印错误并永久冻结输入。HTTP 返回的 restarting 表示已安排重启，实际上线仍需运行版本验收。

## 上线验收

端点就绪状态与切换前比较：原本ready的入口必须保持ready；原本已在reconnecting的远程中继允许同一精确host/origin继续connecting/reconnecting或恢复ready。既有远端网络故障不能单独锁住Gateway重启。新增error、端点/地址变化、本机入口退化仍拒绝验收；原授权、ACL和绑定不变的检查独立执行，不能通过改变状态文案代替。

核对编译 commit/sourceHash、实际新 PID、平台连接、原生 daemon PID、原 grant/ACL/endpoint、任务板服务监听 PID 与静态 index/assets 字节。只更新 Gateway dist 不代表独立 Taskboard 后端已更新；只重启也不代表前端已发布。普通 Taskboard build 会触发 Desktop 注入，不用于本次隔离发布，web 产物显式指定 outDir 后单独原子发布。

release-local、release-rollback-recovery、intent-review-release、taskboard-restart-participant、restart-handoff-boundaries 与 channel-write-leases 覆盖直接规则。安装器/Windows/真实断电和手机连通限制继续记录，不用这套脚本的通过冒充全部平台已验证。

## 本轮发布检查反例

REL-02.3直接运行release-local命令，对成功、回滚、变更owner、旧服务离线、绑定、ACL、浏览器grant、IDE入口、有效期和渠道断连共10场景核验。build标识正确仍不能掩盖授权或绑定变化；回滚只恢复代码，不恢复旧授权。隔离测试不是本轮实际上线，真实切换仍另留构建/进程/回执记录；手机可达性不由本机检查认证。

安装前置版本与清单统一为Node 22.x的22.13+，或23.4+（无实验开关的node:sqlite，且满足锁定Vite）。REL-02.7只验证安装器前置拒绝和当前运行时正常路径，不冒充多Node版本整套兼容性测试。

旧 npm 安装兼容模式的管理页更新（REL-02.8）经 installUpdate → POST /api/update → waitForUpdatedService 观察恢复。每个 bootstrap 请求的响应头与体都须受剩余90秒期限约束，且每次最多5秒；只有目标版本和不同的运行token共同匹配才刷新页面。超时保留旧页面token并明确恢复未确认。当前Git源码部署由 UpdateManager.sourceOnly 拒绝 npm 安装，不会到达这条轮询；不因本修复开启自动更新。
