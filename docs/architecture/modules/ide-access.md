# 项目 Web IDE 与统一浏览器授权

IDE 是独立进程/网络服务，不是 Codex 任务。WorkspaceIDEManager 从确认的原生项目和完整 roots 建 scope，EndpointManager/Provider 在项目所在 host 管理 code-server，AccessServer 校验每个 HTTP/WS 访问。项目对用户保持一个稳定 HTTPS 入口；本机 loopback 只作内部监听，不能拿它作为手机入口。

## 身份、根和授权

2026-11-04 最新决定：用户明确接受“持有项目链接的人可进入文件、Git、终端”。为指定渠道账号显式启用 `linkAccess`，沿用项目固定链接，不接钉钉免登，不要求新浏览器发确认码。配置固定授权来源用户及截止时间（最长 90 天）；该来源必须仍有个人准入和目标 Connector 的非委托完整 IDE 授权。链接访问仅取得该项目会话，不建立或冒充可跨项目复用的个人浏览器身份。项目 URL 现在具有访问能力，不能当作无权限的公开标识转发。

新浏览器通过同源自动 POST 建立项目登录并默认信任实际根；GET 不直接启动进程。到期、撤销来源准入、关闭链接访问、停用主机、原生项目或目录变化均阻止访问。链接策略改变只撤销受影响项目的链接浏览器会话，已有独立个人授权保持原 token 和期限；关掉再打开不会恢复旧 Cookie。旧个人确认方式保留给未启用链接访问的账号。配置和授权文件必须显式识别新模式，旧二进制不得忽略该来源。

scope 包含 owner/host/project/workspace/完整根；名称或 IM 管理别名不扩大范围。旧 scope 迁移要求同一原生身份或唯一完整根集合，不能按主目录模糊迁移。真实路径和私有 workspace 配置限定本次项目入口的根集合，符号链接/其他 host 不串用。完整 IDE 的终端仍具有执行用户的系统权限，项目根集合不是操作系统沙箱。

未启用链接访问的账号继续复用个人准入与原浏览器证明，明确确认一次后持久授权 90 天，不加第二套登录密码。浏览器识别码是确认用途，不是访问凭证；秘密 proof 不放 IM。撤销 epoch 使旧 grant 和旧窗口失效，不能因重启恢复已撤权访问。Gateway 重启与 code-server/原生任务生命周期分开，仍要重新校验新请求。

2026-11-04 简化：首次浏览器只展示一条“确认本人并进入”命令，默认批准并信任目录。已完成个人准入、浏览器证明及信任的登录，在同一渠道账号已有资源权限内复用身份；打开新项目时经同源 CSRF POST、原生归属及 canonical roots 校验，自动签发该项目精确 scope 的会话。GET 不启动 IDE。旧版仅访问、本机管理临时 grant、独立 legacy approver 不自动提升为跨项目身份。仍兼容旧的 access/deny 命令。

链接访问使用 v4 文件，持久化策略指纹和固定期限，不绑定个人浏览器身份。v1/v2/v3 授权可兼容读取；回滚至不识别 v4 的旧二进制会拒绝读取，不能降版本或还原旧授权快照。

v3 授权文件仅保存身份 token 哈希、个人来源/epoch、CSRF 与原截止时间；项目会话关联浏览器身份。新项目期限不超过原身份，退出登录关闭同浏览器各项目长连接，撤销个人准入后重加也不复活旧登录。v1/v2 原项目授权可读且不改原 token/deadline；旧二进制不理解 v3 时应拒绝读取，不能以降版本忽略个人权限。发布回滚必须保留当前授权文件，不可恢复过期授权快照。

展示地址和就绪/授权是不同事实。进展卡调用 `entry(..., { presentationOnly: true })`，仅对仍在运行且远程中继处于 reconnecting 的原端点保留同一固定地址；不换主机或改为回环地址。普通 entry/freshEntry、授权和 HTTP/WS 检查保持原边界。本机网卡离线/地址歧义、停用/关闭端点不沿用旧地址。批准前读取原生项目超时应明确“未批准此浏览器”，不会将其说成 Codex 任务失败或成功授权。

## 部署和验证

本机项目入口按配置的实际稳定网卡/内网路由，远端项目用该 host 的固定入口。TLS、WS 转发、远程安装/补偿、进程身份和启停按独立模块处理。ide-* 测试覆盖 scope、90 天、撤权、HTTP/WS 和回滚；发布前后核对实际授权数量与端点身份。手机连通、实际编辑器主题/字体/键位需要真实设备验证，本机 socket 不能代替。

TLS 配置文件只接受有界的普通文件。证书及私钥路径误指向 FIFO/设备时，应立即拒绝，不能在同步打开阶段卡住整个 Gateway。私钥还保留属主、权限和禁止符号链接检查；证书允许既有符号链接部署方式，但必须验证打开后的实际文件。

## 进程身份的隔离反例

IDE-03.2实际启动并关闭测试自有IDE helper；随后用真实测试canary模拟旧ChildProcess数值PID被复用。保留旧对象的exitCode/signalCode事实，再次stop不得发signal，canary保持存活。此证据证明按自有进程对象及退出证据清理，未声称操作系统实际回收了该PID。

IDE-03.4沿安装器upload到uploadIDEHost验证传输失败资源回收：源读取或stdin写错误立即销毁流、结束自有传输进程并清定时器；成功必须等待流复制完成及进程成功退出。只结束制品传输进程，不操作Codex任务核心。


自动安装制品升级到官方4.141.1，支持Linux x64/ARM64、macOS Intel/Apple Silicon四个固定SHA256与长度。Linux仍要求glibc≥2.28，禁止通过修改系统库绕过兼容检查；不支持的平台保留显式已安装binary入口。ARM64选择和撤销前不激活的测试是安装合同验证，不等于Linux ARM64实际机器运行。官方完整制品校验记录见completion审计目录；原版本的运行实例不因修改pin被停止。

IDE-03.5：官方 code-server 在处理 `--version` 前仍读取并可能创建 YAML 配置。版本/ABI 探测使用本次自有临时目录、0600 空配置及其中的数据/扩展目录，精确比较版本 token，成功和失败都清理；不能把用户配置损坏或默认目录不可写误报为二进制不兼容，也不能为只读探测创建用户密码。四个平台完整 archive 摘要通过；Linux x64 与 Mac ARM64 已实际运行探测和 HTTP 工作台，未把无浏览器心跳的 health=expired 当作完整浏览器会话验收。

本轮实际浏览器验收路径：测试专属项目的两个 Git 根 → WorkspaceIDEManager 生成工作区并启动官方 code-server → IDEAccessServer 签发该测试项目授权 → 独立 Chrome 打开同一固定入口。以工作台 DOM、Git 根列表、编辑器字体和实际终端写出的 cwd 为证据；再次打开及撤权检查原授权与实例。浏览器模拟尺寸不记作手机实机，测试项目与线上 IDE 授权隔离。

## Connector 完整 IDE 与准备状态

`ConnectorIDEHostTransport` 仅替换主机传输，沿用 Manager、AccessServer、profile、完整根和 90 天个人浏览器授权。`peer:` 不能配置 SSH 入口或由 Gateway 下发 binary；共用 Gateway 的 HTTPS 入口。设备明确启用 `webIDE.enabled` 并决定 binary/autoInstall。非委托本人授权才允许完整 IDE，文本共享的 ide-read/ide-write 继续使用原文本页。

`PeerIDEService` 在设备核对已确认的 grant、原生 thread/project、真实根集合，创建最多 8 个 IDE lease。`ide.stream` 只连接本连接已创建 lease 的私有 socket，不接受任意目标；最多 64 条流、32 KiB 块、一方向一个未确认块、顺序检查和写超时。Gateway Cookie/Authorization 不传给 code-server。HTTP/WS 持续核验，撤权关闭连接；原生项目归属每 10 秒复核。Connector 断开清理 IDE 进程，重连保留原 profile 与浏览器证明；Codex 原生任务不因此停止或重发。IDE 终端不承诺跨这类断连存活。

已批准浏览器在 `/workspace` 同一页 POST 查询准备状态，保留 CSRF 和 Origin 检查；`202` 显示下载阶段/字节，ready 后仅导航一次，错误停留并提供重试，不在 workspace/open 间循环。JSON 错误不暴露 SSH/provider 输出，授权失败仍不放行。安装包上传有独立有限总时限，取消立即回收源流和自有 SSH 子进程；它不使用 Codex 任务生命周期。

本次边界与实际测试记录见 `docs/audits/2026-11-04-connector-ide/README.md`。传输夹具不代替完整工作台验收，真实 Chrome 也不代替手机实机。

管理页主机发现合并已登记项目、既有主机配置和已配对且声明 fullIDE 的设备；不要求先绑定项目才可配置。离线配置保留，不把设备出现或管理员启用主机当作浏览器个人授权。实际打开仍要求当前本人设备 grant 和原生项目/目录校验。


## 原生编辑器配置（IDE-08.4）

native-profile.ts 统一解析 settings.json/JSONC、extensions.json 和导出的 .code-profile，HTTP 与管理表单复用该解析器。扩展 ID 为有界 publisher.name，不再枚举固定候选；设置支持扩展自定义项和嵌套语言覆盖，拒绝原型字段及过深/过大数据。Profile 导入仅迁移设置和启用扩展，其余字段必须提示，不假称完整迁移键位、片段或任务。导入接口只返回待编辑数据，保存、安装沿用现有管理权限和主机授权。

内部 settings/extensions 结构未变，不因代码升级重建实例。首次准备查询安装结果，全部核验后保存 extensions-initialized.json；后续重开只报告真实安装状态，保留原生 IDE 卸载操作。显式准备才重新应用基线。失败不写成功回执，安装失败的旧实例下次仍可重试。不扫描项目推荐列表自动安装，不复制桌面登录态；初始基线修改影响所有启用主机，管理页须明确说明。

扩展功能验收必须明确对应的实例与主机。IDE-08.5 的隔离 GitLens 测试仅证明兼容性，不能当作线上各项目已安装的证据。线上补装应使用原实例的 user-data-dir、extensions-dir 和 config；保留现有扩展、JSONC 设置、浏览器授权和 IDE 进程。分别记录安装清单与实际作者/提交浮窗，不能把 CLI 安装成功等同于浏览器已激活。2026-11-06 的配置补齐及验证范围见 `docs/audits/2026-11-06-gitlens-production/README.md`。

## 上游失效与原授权恢复（2026-11-06）

Connector 在线、代理 socket 仍存在，不等于后端 IDE lease 可用。HTTP 代理失败时，按实例 ID 和 socket 路径废止当前 endpoint 的可复用状态；晚到的旧 socket 错误不得废止新实例。编辑器根路径的 GET 转回既有 workspace 页，由原浏览器授权和 CSRF POST 重新核对目录并启动；资源请求及写请求返回失败，绝不自动重放写入。IDEEndpointManager 的按主机包装层必须转发 invalidateEndpoint。该恢复不启动、停止或重发 Codex 任务。IDE-12.3 覆盖此边界；线上远端与手机是否恢复仍需单独核验。

健康检查使用剩余的完整启动时限，包含 Connector 的原生项目归属校验和远端握手；不得用每次 1 秒的探测反复掐断正常慢响应。复用实例同样等待完整探测预算，真正无响应仍按配置时限结束，不因此跳过鉴权或扩大授权范围。

## HTTP 版本边界

IDE 前置入口与共享目录入口使用 runtime/http-contract.ts，与管理 HTTP 共用版本响应头和请求关联。显式声明不兼容的 Gateway API 版本在授权或业务操作前拒绝；没有版本头的浏览器继续原访问流程。Code Server 原始响应、文件字节、WebSocket 流及其认证语义保持上游契约，不用 Gateway 的版本号改写。
