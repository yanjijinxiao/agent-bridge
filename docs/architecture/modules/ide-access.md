# 项目 Web IDE 与统一浏览器授权

IDE 是独立进程/网络服务，不是 Codex 任务。WorkspaceIDEManager 从确认的原生项目和完整 roots 建 scope，EndpointManager/Provider 在项目所在 host 管理 code-server，AccessServer 校验每个 HTTP/WS 访问。项目对用户保持一个稳定 HTTPS 入口；本机 loopback 只作内部监听，不能拿它作为手机入口。

## 身份、根和授权

scope 包含 owner/host/project/workspace/完整根；名称或 IM 管理别名不扩大范围。旧 scope 迁移要求同一原生身份或唯一完整根集合，不能按主目录模糊迁移。真实路径和私有 workspace 配置限定编辑范围，符号链接/其他 host 不串用。

复用个人准入与原浏览器证明，明确确认一次后持久授权 90 天，不加第二套登录密码。浏览器识别码是确认用途，不是访问凭证；秘密 proof 不放 IM。撤销 epoch 使旧 grant 和旧窗口失效，不能因重启恢复已撤权访问。Gateway 重启与 code-server/原生任务生命周期分开，仍要重新校验新请求。

展示地址和就绪/授权是不同事实。进展卡调用 `entry(..., { presentationOnly: true })`，仅对仍在运行且远程中继处于 reconnecting 的原端点保留同一固定地址；不换主机或改为回环地址。普通 entry/freshEntry、授权和 HTTP/WS 检查保持原边界。本机网卡离线/地址歧义、停用/关闭端点不沿用旧地址。批准前读取原生项目超时应明确“未批准此浏览器”，不会将其说成 Codex 任务失败或成功授权。

## 部署和验证

本机项目入口按配置的实际稳定网卡/内网路由，远端项目用该 host 的固定入口。TLS、WS 转发、远程安装/补偿、进程身份和启停按独立模块处理。ide-* 测试覆盖 scope、90 天、撤权、HTTP/WS 和回滚；发布前后核对实际授权数量与端点身份。手机连通、实际编辑器主题/字体/键位需要真实设备验证，本机 socket 不能代替。

## 进程身份的隔离反例

IDE-03.2实际启动并关闭测试自有IDE helper；随后用真实测试canary模拟旧ChildProcess数值PID被复用。保留旧对象的exitCode/signalCode事实，再次stop不得发signal，canary保持存活。此证据证明按自有进程对象及退出证据清理，未声称操作系统实际回收了该PID。
