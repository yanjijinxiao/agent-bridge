# 构建、发布与 Gateway 重启

发布先在独立目录完成编译、类型/用例和静态制品准备；push 状态、准备制品、实际运行版本分别验收。release-local 的 prepare/seal/switch/verify 保留旧制品及持久发布回执，失败恢复必须解除属于本次发布的冻结，不留下永久“消息等待交接”。脚本不创建无限后台等待切换任务。

## 门禁保护范围

AccountManager 的同一 release lease 只保护 Gateway 尚在提交的原生写、审批/答案 flush、结果/媒体投递及其他实际外部交接。已由独立核心接收的任务和只读观察等待不阻止重启。systemError pending、capacity checking/settling 不能伪装成活跃写。渠道真实 write 单独持 lease，typing/读入不持。

Taskboard 借用同一个根原生端口并参与同一 release participant；freeze 同步阻止新输入/明确停止/答案提交，取消发布恢复。停止 Gateway 退休观察和本地资源，不 interrupt 原生任务、不重发已接收或回执未知输入。显式私有 stdio 仍是宿主生命周期，不能承诺 daemon 的隔离保证。

网页 npm 更新入口也遵守同一归属：独立目录准备制品后异步启动重启助手必须把成功/失败回传给持有 release lease 的 HTTP 层。启动失败应释放本次 lease，保留当前 Gateway 服务；不能只在后台打印错误并永久冻结输入。HTTP 返回的 restarting 表示已安排重启，实际上线仍需运行版本验收。

## 上线验收

端点就绪状态与切换前比较：原本ready的入口必须保持ready；原本已在reconnecting的远程中继允许同一精确host/origin继续connecting/reconnecting或恢复ready。既有远端网络故障不能单独锁住Gateway重启。新增error、端点/地址变化、本机入口退化仍拒绝验收；原授权、ACL和绑定不变的检查独立执行，不能通过改变状态文案代替。

核对编译 commit/sourceHash、实际新 PID、平台连接、原生 daemon PID、原 grant/ACL/endpoint、任务板服务监听 PID 与静态 index/assets 字节。新版嵌入式 Taskboard 固定打包到 Gateway dist/node_modules/codex-taskboard，包含服务端、共享模块、技能及CLI、运行依赖脚本和 web；同一 dist 的切换/回滚包含它们。独立 Taskboard 仍需核对其自身监听进程，不能以 Gateway 重启代替。普通 Taskboard build 会触发 Desktop 注入，不用于隔离发布；准备阶段使用 build:web 或显式 outDir，不注入或重启 Codex App。

release-local、release-rollback-recovery、intent-review-release、taskboard-restart-participant、restart-handoff-boundaries 与 channel-write-leases 覆盖直接规则。安装器/Windows/真实断电和手机连通限制继续记录，不用这套脚本的通过冒充全部平台已验证。

## 本轮发布检查反例

REL-02.3直接运行release-local命令，对成功、回滚、变更owner、旧服务离线、绑定、ACL、浏览器grant、IDE入口、有效期和渠道断连共10场景核验。build标识正确仍不能掩盖授权或绑定变化；回滚只恢复代码，不恢复旧授权。隔离测试不是本轮实际上线，真实切换仍另留构建/进程/回执记录；手机可达性不由本机检查认证。

安装前置版本与清单统一为Node 22.x的22.13+，或23.4+（无实验开关的node:sqlite，且满足锁定Vite）。REL-02.7只验证安装器前置拒绝和当前运行时正常路径，不冒充多Node版本整套兼容性测试。

旧 npm 安装兼容模式的管理页更新（REL-02.8）经 installUpdate → POST /api/update → waitForUpdatedService 观察恢复。每个 bootstrap 请求的响应头与体都须受剩余90秒期限约束，且每次最多5秒；只有目标版本和不同的运行token共同匹配才刷新页面。超时保留旧页面token并明确恢复未确认。当前Git源码部署由 UpdateManager.sourceOnly 拒绝 npm 安装，不会到达这条轮询；不因本修复开启自动更新。


## npm 独立制品与程序回退

UpdateManager只向同文件系统的私有准备prefix安装，依赖保留在候选package内，不让npm覆写正在运行的目录。版本、入口、整个候选树字节/权限/内部链接摘要写入release.json；外部符号链接拒绝。下载期间不持发布lease，准备完成后才由HTTP请求短期交接；交接忙时旧服务继续运行。

restart-helper先等待原Gateway退出，按持久阶段把原package移入备份、候选移到原路径，再启动新版；/api/build必须匹配产品、版本和新子进程PID才能确认。启动失败或健康确认失败时只停止自己启动的子进程，恢复旧程序并再次核验。账号、ACL、浏览器grant和消息/原生回执从不随程序回滚。备份和失败候选保留，rename与阶段写之间的丢确认可识别重试；不创建轮询所有Codex任务的切换进程。

REL-02.9验证实际测试子进程成功/失败回退、目录EBUSY、rename丢确认、候选变更、外部链接、准备期准入和短期交接拒绝。尚未证明Windows实机、真实registry发布或整个主机断电后服务管理器自动恢复。此npm兼容功能不启用源码部署的更新按钮，不改源码发布流程。UI分别显示准备与版本确认，未确认时不声称已安装成功。

REL-02.10：实际正常目录/账号请求出现5～9秒延迟，固定5秒单次探测会误判。每次响应头和JSON体共用至多15秒、且不超过本次验证剩余期限的signal，总验证仍为45秒；失败记录类型和已验证条件，不记录凭据。外层编排不能用小于完整切换及回滚预算的超时杀死发布助手。若外层确实退出，先核对原制品、恢复进程和原release owner，再仅解除本次冻结并保存已退出助手的锁；不能盲目清锁或修改别人的授权。

## HTTP 连接收尾

管理 HTTP 入口在启动时记录自己接受的 socket。关闭先停止接受新连接并给已有响应 5 秒完成；到期只销毁仍未完成的连接，包含半个请求头、未传完的正文及升级连接。重复 close 复用同一次结果，正常请求在期限内可返回；不会向原生 Codex 执行器发送停止信号，不因响应断开而重放写入。

REL-02.11 使用真实 TCP 和 Gateway 子进程覆盖上述边界。HTTP 连接预算不是整个 Gateway 所有清理步骤的总超时；其他模块仍须完成自己的资源清理。历史线上挂起缺少关闭阶段记录，不能仅凭本次反例断言所有旧挂起都来自这一处。
