# 统一版本、兼容与诊断

## 职责和事实源

所有 Gateway 自有接口和运行日志纳入同一版本制度，但程序发布号、接口兼容号和日志结构号不是同一个数字。`src/runtime/versions.ts` 是运行契约清单的唯一入口；`package.json` 是产品发布号来源；发布制品的 `build-info.json` 证明实际编译的 commit/sourceHash。不能用 Gateway 的版本代替 Connector 的版本，也不能用当前 Git 工作目录推断一个已运行进程的版本。

每个进程在启动时固定自己的 component、productVersion、build、instanceId、pid、startedAt 和 contracts。没有封存构建清单时明确标记 development/unsealed，不能伪装成已发布制品。原生 Codex 的版本或 userAgent 只能来自实际握手，单独记为 upstream；Gateway 的 adapter 版本不冒充上游协议版本。

## 兼容规则

| 领域 | 权威与当前规则 | 读取边界 |
| --- | --- | --- |
| 发布制品 | package.json 产品号；封存清单的 commit/sourceHash/builtAt/productVersion | 程序加载时固定，不能被磁盘后续替换重新标号 |
| Gateway HTTP | contracts.http，当前 1.0 | 管理端、IDE 前置入口、共享目录入口；不改 Code Server 上游协议 |
| Connector RPC | contracts.peer / execution，当前均为 1.0 | protocol.negotiate；已有 v1 envelope、权限检查和回执语义保留 |
| 原生适配 | contracts.nativeAdapter，当前 1.0 | 表示本项目适配约定；上游实际 userAgent 来自 initialize |
| 运行日志 | contracts.log，当前 1.0 | stderr JSONL；schemaVersion 为主版本，完整版本在 runtime.contracts.log |
| 持久数据 | 各存储 schema 的已有版本与迁移程序 | grants、设备凭据、共享记录、消息回执不能随程序版本强行改号或回退 |

统一的是版本登记、兼容决策和验收流程，不要求这些领域共享同一递增数字。新增持久格式或配置格式必须在本表及所属模块登记其 schema、读写者、旧版本迁移和未知版本拒绝规则。当前持久格式保持原实现，未执行批量迁移。Taskboard 的独立服务和外部渠道 SDK、Code Server、Codex 仍拥有各自的接口与版本，不能因 Gateway 更新就声称它们已更新。

- 自有 HTTP API、Peer RPC、执行适配、日志分别有 major/minor。新增可选字段可以提升 minor；删除字段、改变含义或必填要求必须提升 major，并提供迁移与混合版本测试。
- Peer 先调用独立的版本协商方法，再沿原来的严格注册结构注册。这样不向旧版 strict 注册对象塞入新字段。只在旧端明确返回 unsupported 时进入 legacy 模式；超时、断线、畸形响应或明确不兼容不能伪装成旧版成功。
- 同 major、不同 minor 可以连接；未知或不一致的 Peer/执行 major 在提交业务前拒绝。版本信息不授予设备、聊天或文件权限，原有 grants 和逐请求权限检查不变。
- 旧 Connector 可以继续使用既有 v1 能力，但管理接口明确显示 legacy/version-unreported。不能从功能标志猜测其 Git commit，也不能自动升级、改执行器或重发任务。
- HTTP 保留现有 URL 和响应体，统一附版本及请求 ID 响应头。未带版本的旧客户端按当前 v1 兼容；显式声明不支持的 major 时在业务执行前返回版本错误。
- 文件、管理、共享、IDE 等能力仍独立声明，数字从统一契约清单取得。能力开关不是产品版本；旧共享授权等持久格式保持原迁移和拒绝降级的规则，不批量重写历史文件。

## 日志与排障

Gateway 和 Connector 入口统一安装 JSONL 日志输出。每条运行记录带日志 schema、进程版本和实例身份。既有 console 日志标为 legacy.console，不能冒充已经具有完整事件语义的新事件。交互终端的配对码、确认提示和帮助文字属于面向操作者的输出，不包装成运行日志；原生 JSON-RPC/stdout 与 IDE 字节流也不能被日志包装污染。

Peer 两端用同一 requestId 关联请求开始、完成、拒绝和超时；从 HTTP 或另一条 RPC 派生请求时保留 parentRequestId。嵌套的原生 RPC 继承请求上下文并记录 nativeRequestId、方法、hostId 和耗时；nativeConnectionId 每次重新连接更新。新事件只接收白名单诊断字段，不记录 prompt、审批答案、凭据、附件正文或原始 RPC 参数/结果。旧 console 文本增加 URL、Bearer 和具名凭据脱敏，但它不是任意秘密字符串的检测器；新增代码须使用结构化事件，不能把原始 payload 塞进 console。未知错误保留安全类型/阶段，不能用无关联 ID 的泛化错误作为完整诊断。

管理接口分别报告 Gateway 和各 Connector 的实际版本、连接兼容状态及导出的 nativeHostId。SSH 别名不是已解析 IP；未获取的上游地址、版本或 Home 必须保持 unknown，不能补猜。断连后显示最后一次报告和离线状态，不将其当成当前连接验收。

GET /api/versions 是管理端汇总入口；/api/build 保留旧字段并增加 runtime，/api/connectors 保留 routes 并增加 compatibility、runtime、nativeHosts。它们沿用原管理端访问边界，不作为 IM 任意用户可查看全部设备的接口。Connector 版本是已认证连接的自报告，不是签名制品证明；没有报告则 runtime=null、compatibility=legacy。离线快照只保存在当前 Gateway 进程内，Gateway 重启后未重连设备不能凭空恢复版本证据。

HTTP 响应附 X-Gateway-API-Version、X-Gateway-Instance、X-Gateway-Request-ID、X-Gateway-Interface。显式不兼容返回 HTTP 426、api-version-incompatible、submission=not-submitted，不能据此重放其他未知提交。日志消费者使用 event 和 schemaVersion；启动检测读取 runtime.ready 的 surface/port，不再解析旧的 “is running at” 文本或含凭据 URL。终端帮助与交互提示仍按人类可读格式输出。

## 发布和变更要求

每次接口或日志改动都先判断兼容性，更新本清单、模块说明和 case；代码与文档一起审查。发布验收分别核对 Gateway、Connector、上游服务，保留旧新混合版本、缺失版本、不兼容、重连、并发关联和脱敏的反例。版本不一致本身不是停止既有 Codex 任务的理由。

本次增量只验证明确列出的边界；没有登录知游的开发机，不能据此宣称其会话漏项已修复。实际上线与各设备升级需要独立记录。

## VER-02 npm 与产品名称

产品为 Agent Bridge，发行包为 @yanjijinxiao/agent-bridge；仓库名为 agent-bridge。Gateway 和 Connector 使用同包的两个 bin，共用根 package.json 的 version。CLI --version、构建清单 productVersion、运行身份和 npm tarball 必须一致，Git 标签为 v 加该版本。工作区保持 private，scripts/package-npm.mjs 生成去除开发工作区和构建脚本的发布清单；只在独立新目录构建，不接触 live dist。

Taskboard 随 dist/vendor 一起移动与回滚，避免 npm 丢弃嵌套 node_modules。源码模式仍使用工作区模块，编译模式只使用内嵌版本。更新器支持 scoped 安装路径以及旧路径，registry URL 正确编码包名；源码部署不误入 npm 更新。旧协议 product 标识、环境变量、目录和设备凭据保留，不因改名失去现有连接。

参见 [发布流程](../npm-release.md)、test/npm-package.test.ts、test/update-manager.test.ts、test/npm-release.test.ts、test/taskboard-release-package.test.ts。安装后的真实启动另留制品回执，纯 fixture 不代替 registry 发布验收。
