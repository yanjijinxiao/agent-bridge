# 统一版本与诊断：四层增量检查

基线：cce640c89e0efcceb885fb33c55edd9d64d466b6。范围是本轮 Gateway/Connector 版本、兼容与日志增量，未声明重新逐行验收全库。具体源码散列与修改行范围见 [文件清单](2026-11-06-version-contracts-files.json)。未修改的 .DS_Store 不纳入本轮。

## 架构层

此前 Gateway 的构建号、Connector 的功能标志、原生客户端硬编码版本及无统一结构的日志分散管理，无法证明一个在线设备实际加载的代码。新增 runtime/versions.ts 作为自有契约清单；封存制品、进程身份、接口兼容、上游实际握手各有事实源。

Gateway 不代替 Connector 报告版本；未报告明确为 legacy/null，离线只保留当前进程最后一次报告。持久回执、grants 和原生任务仍由原模块管理。版本差异不引入第二套执行器、自动升级或输入重放。

HTTP、Peer、执行适配、日志分别管理主次版本；外部 Codex、Code Server、渠道 SDK 及独立 Taskboard 不冒用 Gateway 的版本。各持久 schema 沿用已有迁移；此次没有改写历史数据或批量提升格式版本。

## 模块层

- Peer：设备认证后独立协商，再使用原严格注册结构；唯一旧端回退条件是明确 unsupported。畸形、拒绝、断线和超时不得假装成功。拒绝后继续发请求也不能执行。
- Registry：已发布路由记录本连接版本，导出的 nativeHost 保持别名与路由对应；重连替换实例，离线不伪装新版本。返回副本防止管理调用者修改内部状态。
- HTTP：管理、IDE 前置入口、共享目录入口共用版本和关联头；旧浏览器无头继续访问。显式不兼容在业务写入前返回426。原管理端权限及 IDE 校验仍执行。
- 日志：HTTP → Peer 的父子请求、两端相同 wire requestId、原生连接/请求 ID 可关联；并发上下文隔离。新事件只接受白名单字段，旧 console 文本标明 legacy.console 并作常见凭据脱敏；日志输出不是提交成功的前置条件。
- 原生：initialize 报告当前产品版本，上游 userAgent 单独记录。重连生成新的诊断连接 ID，不改原生请求与回执语义。

## 文件与函数层

本轮阅读新增 runtime 四个文件、Peer RPC 与协商/注册边界；复核原生 request/startAppServer、管理 HTTP/IDE/共享入口、两个进程入口和发布封存的修改范围及调用关系。大文件没有逐行重读全部未变化业务，文件清单的 changedRanges 明确限定范围。

function-contracts.jsonl 新增10项有精确行范围与散列的函数记录；VER-01.1–VER-01.13 映射16项具体测试。历史 partial 场景未提升，旧散列不冒充本次源码已审读。

## 静态、配置与发布层

构建清单增加 productVersion，旧清单仍可读取。产品和清单在模块加载时固定；隔离制品没有 package.version 也可从封存清单获得产品号。真实子进程用例证明运行中替换清单不会重新标号，新进程读取新版本。

统一 JSONL 会影响原日志解析者，因此实际 Gateway 启动用例已改读 runtime.ready 的 port/surface，不再匹配自然语言 URL。终端帮助与配对提示仍为人读输出；协议 stdout、Code Server 字节流不包装成日志。README、功能总表、架构入口、Peer/原生/IDE/管理/发布模块和探探教程已同步；未修改探探的固定连接地址。

## 验证与失败记录

- 类型检查通过；TypeScript 输出到隔离临时目录，未覆盖线上 dist；编译后的版本模块导入通过，缺封存清单明确为 unsealed。
- 完整根回归：3388项，3300通过、88环境条件跳过、0失败、0取消。之后补充父请求关联、原生重连身份与封存制品子进程反例，最终定向回归87项全部通过，无跳过。
- 定向范围包含 runtime-versions、server-shutdown、release-local、peer-transport、peer-ide、peer-sharing、peer-workspace-page 和 http-server。实际 Gateway 测试子进程 SIGTERM 后退出，独立执行器未被停止；IDE HTTP/WS 字节转发仍通过。
- 首次受限环境测试无法监听本机端口（EPERM），经工具审批在隔离本机端口重跑。第二轮出现一项测试夹具超时：额外连接覆盖了夹具保存的连接，重连等待了错误对象；修正操作顺序后通过。该轮取消结果没有记作通过。
- 上述代码验证阶段没有 push、部署或重启头头/探探；发布阶段单独记录实际制品、进程与连接验收，不改写这份测试结论。

## 仍未证明的边界

知游开发机 11.158.199.30 的实际 Connector 版本、SSH 别名最终落点、Codex Home 与 /sessions 漏项原因仍需真实连接与日志核对；此次没有登录该设备，不能声称问题已修复。版本报告是已认证端点的自报告，不是签名制品认证。旧 Connector 升级前不会自动拥有新日志格式；历史日志不回写。独立 Taskboard 与外部服务日志仍按各自协议管理；手机、全部未来协议组合和任意断电窗口未在本次验收。
