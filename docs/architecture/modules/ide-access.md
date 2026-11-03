# 项目 Web IDE 与统一浏览器授权

IDE 是独立进程/网络服务，不是 Codex 任务。WorkspaceIDEManager 从确认的原生项目和完整 roots 建 scope，EndpointManager/Provider 在项目所在 host 管理 code-server，AccessServer 校验每个 HTTP/WS 访问。项目对用户保持一个稳定 HTTPS 入口；本机 loopback 只作内部监听，不能拿它作为手机入口。

## 身份、根和授权

scope 包含 owner/host/project/workspace/完整根；名称或 IM 管理别名不扩大范围。旧 scope 迁移要求同一原生身份或唯一完整根集合，不能按主目录模糊迁移。真实路径和私有 workspace 配置限定编辑范围，符号链接/其他 host 不串用。

复用个人准入与原浏览器证明，明确确认一次后持久授权 90 天，不加第二套登录密码。浏览器识别码是确认用途，不是访问凭证；秘密 proof 不放 IM。撤销 epoch 使旧 grant 和旧窗口失效，不能因重启恢复已撤权访问。Gateway 重启与 code-server/原生任务生命周期分开，仍要重新校验新请求。

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
