# 验证收尾：HTTP 退出与 GitLens

## 范围和依据

接续原生配置、自助登记变更的两个未完成边界：真实 code-server 的 GitLens 安装/激活/提交浮窗，及 Gateway 收到 SIGTERM 后没有及时退出。同步 README、教程和当前模块合同，不改写历史测试事实。

## HTTP 反例与修复

旧管理 HTTP 入口只等待 server.close；客户端只发送半个 HTTP 请求头时，监听端口虽然已关，真实 Gateway 子进程仍未退出。修改前回归失败见 shutdown-before.tap。新入口记录自己的连接，保留 5 秒响应收尾窗口，到期清理遗留 socket。没有修改发布准入，也不停止独立原生执行器。

新用例包括半个请求头、未传完的正文、升级连接、正常响应完成、重复 close，以及真实进程 SIGTERM 后锁释放/独立进程存活。相关 48 项通过，全量 3,235 项：3,150 通过、85 条件跳过、0 失败，typecheck 通过。原线上挂起未保留关闭阶段现场，本次确定复现的缺陷不能证明是每次旧挂起的唯一原因。线上正常退出另行记录。

## 四层增量检查

- 架构：HTTP 连接由 Gateway 自己管理；原生任务、输入回执和进程锁归属不变。
- 模块：停止接入、响应排空、超时残留、重复关闭和升级连接都由同一关闭函数处理。
- 文件/函数：socket close 事件清理集合；timer 正常完成时释放；同步/异步回调均只结算一次；真实 TCP 及进程验证不只断言字符串。
- 静态/配置：中英文 README、探探教程、Peer 指南、共享编辑器说明及原生配置使用步骤同步。历史验证文档标注当时行为，不要求新用户领取 token/CA。旧身份与状态迁移、权限隔离、共同初始基线的影响明确保留。

## GitLens 与线上结果

真实 code-server 4.141.1 + GitLens 19.5.0，在 Mac ARM64 的隔离 Chrome、临时 Git 仓库中验证安装、激活、行作者/时间及提交详情浮窗。浮窗实际显示作者、提交标题、完整说明、匹配的提交哈希和变更内容，见 [截图](gitlens-hover.png) 与 [制品/环境记录](gitlens.json)。官方 Open VSX 文件 CDN 本次超时，使用 GitLens 官方 GitHub 发布的 VSIX；ZIP 完整性及扩展身份通过，本地记录 SHA256，不冒充独立发布签名。生产实例的扩展清单未改变，不把此次安装称为每台设备的注册表一键下载验收。

代码 2eca290 已 push 并上线头头/探探。头头新版接受半个 HTTP 请求头后正常 SIGTERM，旧 PID 在 6,714 ms 内退出，launchd 拉起新版；六个既有原生 Codex 进程保持原 PID，所有原 IDE 入口 ready，账号 running。探探 Gateway 是容器主进程，SIGTERM 使容器停止；显式启动原容器后新版运行，账号 running，三个原 Connector 主机恢复。没有重启 Connector 或桌面 Codex；本次发布占用已解除。详见 [部署回执](deployment.json)。

## 可重复的真实扩展用例

IDE-08.5 已另跑通过（1 项，0 跳过）。设置 CODEX_CHROME_TEST_BIN、CODEX_REAL_IDE_TEST_BIN 和 CODEX_GITLENS_TEST_VSIX 为实际 Chrome、code-server 与已核验官方 VSIX 的路径，然后运行 test/ide-gitlens-browser.test.ts。用例自行创建临时仓库、写入确定的提交、安装扩展、打开工作台并断言作者/标题/正文/短哈希；不需要个人登录资料，普通测试未设置这些路径时明确跳过。此单独实测不混入此前 3,235 项全量计数。首次自动化失败来自浏览器快捷键就绪/鼠标进入时机，调整为实际文件树双击和鼠标移入后通过。证据见 gitlens-browser.tap。
