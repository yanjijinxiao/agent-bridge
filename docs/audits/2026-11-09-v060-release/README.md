# Agent Bridge 0.6.0 发布核对

## 发布身份

- 产品版本：0.6.0；代码与 Git 标签：74c08b2ea4c4ceb9c6a94a9ffa0a32cfa8e673f3 / v0.6.0。
- sourceHash：6ea7de1e7bd2880de3c2c2b5300b28aaf229660c43f7171e231398264a4c12cd。
- npm 制品：2,424,646 字节，993 文件；SHA-256：dd32362efc1a97755888a3fcf2e2026659eb889d9ecd0f801a66d809028e96d6。
- GitHub Release 已正式发布，附件回下载并通过 SHA-256 核对。npm 0.6.0 已公开发布，latest=0.6.0，访问级别 public；官方 registry 下载完整性与干净安装验证均已完成。

## 四层核对范围

1. 架构：产品发布号由根 package.json 提供，Gateway/Connector 共用包与源代码。HTTP、Peer、执行和日志合同版本独立；这次没有更改协议、任务执行入口或权限。
2. 模块：核对 npm 发布清单、CLI 版本、build-info、内嵌 Taskboard 及程序更新目录。GitHub 附件和所有新 Connector 目录来自同一验证 tarball；头头 Gateway 使用同提交、同 sourceHash 的隔离全量构建。
3. 文件与函数：publicationManifest/packageNpm 的静态文件装配、版本读取与运行身份相关 30 项回归通过。此次相对已验证的功能提交没有新增运行时逻辑；不声称重新逐行自检整个仓库。
4. 静态与配置：根 package/lock 版本同步，更新中英文 README、Herdr 安装教程、CHANGELOG；CHANGELOG 进入 npm 包。制品排除 .git、.npmrc、设备令牌、私有部署状态及内部审计文件。

## 验证

- TypeScript 检查通过。
- Gateway 全量：3,769 项，3,678 通过，91 项按环境条件跳过，0 失败。
- Taskboard 全量：510 项，508 通过，2 跳过，0 失败。
- 干净 prefix 安装真实 tarball；两个 CLI 的 help/version、隔离 Gateway /api/build、网页、Taskboard /health 与构建静态资源通过。见 smoke.json。
- 跳过用例不计入已完成验收，本次没有新增真实群消息或浏览器操作测试；沿用功能修复时的接口与端到端证据。

## 上线

头头和探探 Gateway 已运行上述版本，维护的五个 Connector 同步到 0.6.0（头头 Mac、探探 Mac Codex、Mac Herdr App、Linux Codex CLI、Linux Herdr TUI）。头头的远程主机路由由同一个 Mac Connector 提供，不另算一个进程。版本、PID 与在线状态见同目录两份 online.json。

头头保留 45 条绑定、32 份浏览器授权指纹、90 天授权期限及三个 IDE 端点；探探精确核对 19 条绑定与授权期限。两边钉钉连接恢复，发布交接入口已重新开放。程序更新不停止 Codex/Herdr 原生执行器，也不重放已经接收的输入。

探探 Mac Connector 首次 launchd 重载因旧服务退出尚未完成返回错误；核对旧 PID 已退出后重新 bootstrap 成功，最终在线。后续头头 Connector 明确等待旧 PID 退出后加载。此过程没有重启 Codex App 或 Herdr App。

## npm 发布过程

npm 登录凭据失效返回 401；两次网页登录因用户未收到邮箱验证码而超时。第三次按用户通行密钥需求提供官方网页授权入口；用户截图确认账号正确，但 npm 实际页面仍只提供邮箱 OTP，没有设备验证按钮。不能根据以往发布成功推断当前账号已启用通行密钥登录，也不能通过反复换 CLI 链接解决邮箱投递问题。用户随后在另一台机器通过通行密钥完成登录，本机 npm whoami 确认身份；这说明不能从单台浏览器的邮箱页面推断账号没有启用设备验证，具体浏览器差异尚未确认。用户完成独立的发布网页验证后，npm publish 成功接收同一 tarball，并提示正在处理新版本。随后已完成下述官方 registry 验证。


## 官方 registry 安装验收

2026-11-09 04:57 UTC 官方 registry 的 latest 已指向 0.6.0，独立版本接口和实际 tarball 下载成功。SHA-512 与发行前验证制品一致，SHA-256 为上述发布身份。公开索引短时仍命中旧 CDN 缓存，独立版本接口和带缓存区分参数的元数据交叉核对成功；没有重复发布或增加新版本绕过处理。

从官方 registry 按包名安装到独立 prefix、使用全新缓存。第一次下载依赖遇到 ETIMEDOUT，记录为网络失败；降低并发后重试成功，安装 131 个包。没有将失败改记为通过。随后两条 CLI 的 help/version、Gateway /api/build 和网页、内嵌 Taskboard /health 与构建静态资源验证均通过，运行版本 0.6.0 / 提交 74c08b2 一致。见 registry-verification.json 与 registry-smoke.json。

GitHub Release 已去掉待认证提示并恢复 npm 安装说明。本次 npm 发行与此前已上线的头头、探探、五个维护中 Connector 对齐，不需要为发布 npm 再重启同一线上版本。
