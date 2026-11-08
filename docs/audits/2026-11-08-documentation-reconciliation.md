# 最近修复的功能、模块和回归文档核对

## 范围与发现

用户要求确认最近的 bug 和功能是否已写入功能文档、模块文档及其他维护入口，防止后续维护遗忘旧要求。本次核对三个代码提交：8b0ffa4（斜杠转发和 Herdr 帮助）、1ef533d（IDE 页面兼容）、dd2c627（远程 IDE 稳定性）。

三个提交已经更新需求 JSON、对应模块、测试和增量审计；命令及浏览器行为也已写入探探、Herdr 教程。但功能总文档、实现职责图、覆盖汇总和精选函数索引未完全同步。首页及剩余工作中还有被误写成“当前”的旧计数，功能总文档保留了过时的 Herdr 未上线、IDE 一律要求 IM 确认的描述。

这些是维护文档缺口，不能用“已写了模块文档”声称全部同步。本次补齐下列五项合同的维护入口，修正一条 CTRL-05.runtime-help 的旧实现散列；仅更新已重新阅读的相关函数，不批量刷新历史证据。

## 要求、实现与 case 对应

| 功能或缺陷 | 功能 case | 模块及实现 | 回归文件与反例 |
| --- | --- | --- | --- |
| 未注册斜杠先文字提示，再原文转发 | IN-01.slash-forwarding | [消息交接](../architecture/modules/inbound-forwarding.md)、[控制](../architecture/modules/input-controls.md)；channel-commands → BridgeService | slash-forwarding、runtime-channel：路径/引文、内置和扩展别名、参数错误、能力拒绝、共享权限、原文和重复来源 |
| Herdr 完整帮助、分项及单命令帮助 | CTRL-05.runtime-help | [运行接口](../architecture/modules/agent-runtime.md)；runtime-help 共用注册表与 runtime-command-policy | runtime-command-policy：所有内置与别名、主题筛选、扩展、Taskboard 开关及动态中断能力 |
| IDE 页面缺少 AbortSignal.timeout 时直接失败 | IDE-14.webview-timeout | [IDE 访问](../architecture/modules/ide-access.md)；link-entry 的实际页面脚本 | ide-link-entry-script、ide-project-link：缺失 API、重复点击、超时、网络错误、401/403、503、异项目/外域重定向 |
| 历史阶段重复复制使同步状态写入拖慢所有请求 | STATE-01.stage-dedup | [持久状态](../architecture/modules/persistent-state.md)；ThreadEventHub → compactArchivedSummaries | follow-checkpoint-compaction：旧格式加载、连续轮次、重建、共享对象、相同阶段和不同回执、唯一副本、旧最终结果和待处理附件动作 |
| 单次健康检查失败拆除仍可用的远程中继 | IDE-03.health-retry | [IDE 访问](../architecture/modules/ide-access.md)；RemoteIDEIngress.run | ide-ingress-health：一至两次失败保留连接、连续三次重连、成功清零及清旧错误、真实 SSH 退出、关闭停止探测 |

完整精确测试名及实现散列保存在 [gateway-requirements.json](../architecture/gateway-requirements.json)。[功能合同](../architecture/gateway-contracts.md)、[实现映射](../architecture/gateway-implementation-map.md)、[覆盖摘要](../architecture/gateway-case-coverage.md)使用同一组 case ID。

## 原功能必须保留的边界

- 命令分类不是授权。个人准入、聊天角色、共享范围、绑定代次、忙碌策略、来源去重仍独立检查；注册命令出错不能转成终端输入，旧卡片回调不能成为普通消息。
- Herdr 终端快照不等于 Codex 历史，终端中断不等于任务成功；旧审批与队列记录保持原执行目标，不因帮助或目录切换改写。
- IDE 页面修复不放宽同源、Cookie、短期证明、项目范围或固定期限；过期请求需手动重新打开，不循环刷新。显式持链接访问与默认个人确认是两种已有策略，不混写成取消鉴权。
- 阶段去重不删除历史最终答复、附件动作或不同的重试/回执。当前没有承接副本时不删除；浅复制避免擦掉共享对象里的唯一副本；不改输入恢复或同步原子保存合同。
- 中继恢复只管理自己的连接，证书校验、授权、项目固定入口和独立 agent 任务生命周期保持原职责；连续故障仍恢复，不掩盖为 ready。

## 四层文档复核

1. 架构：核对注册、执行权限、输入交接、结果持久化与 IDE 网络职责；补入实现职责图，未增加执行器或新的设置持久化来源。
2. 模块：消息交接、控制、运行接口、持久状态及 IDE 模块引用同一组 case；修正旧的斜杠分类概述，明确异常和正常对照。
3. 文件与函数：按实际源码阅读并登记 parseCommand、mayBeChannelCommand、classifyChannelInput、runtimeHelp（含静态 entries）、runtimeCommandOperation、runtimeCommandRestriction、IDE_LINK_ENTRY_SCRIPT、compactArchivedSummaries、archiveTerminal、RemoteIDEIngress.run 共十项。行范围和文件散列见 [function-contracts.jsonl](../architecture/function-contracts.jsonl)。另发现 readNpmRelease 存在两条不同版本的同名记录，已合并并按当前实际函数范围重读，保留 REL-02.9 与 VER-02.2 的场景身份；其旧记录仍可由 Git 历史查看。其他历史函数记录未冒充本轮已复核。
4. 静态与配置：校准架构首页、功能合同、覆盖表、实现图、剩余清单和审查方法；核对教程已有的命令/重试说明及文档链接。本次不改运行配置、制品、授权或服务。

需求记录当前为96项要求、459case：364项有列明边界的通过记录、95项部分覆盖，全部有测试映射。精选函数记录302项；最近修复新增十项，另外合并并复核一项已有重复记录，共十一项在本轮核对。统计来自既有记录，不等于459项本轮重新验收，更不代表全部文件/函数已经语义证明。

## 验证与发布边界

本次只做文档同步与相应回归核对。隔离回归首次在沙箱内绑定127.0.0.1时被EPERM拒绝；使用获准的本机端口执行方式重新运行，未连接线上账号或重启服务。六个相关测试文件共69项通过、0失败、0跳过。日志摘要为 SHA256：e71cf08cc1512b3a81252b320f6dd6e477143609c11d7a063398a894e794aca6。缺少静态 timeout API 的真实 Chrome 测试沿用前次明确运行记录，本次没有重跑浏览器。

重复函数记录校正另跑 scoped npm 目标隔离及回退场景1项通过；本轮合计70项通过。文档检查核对五个 case 在功能文档、实现图、首页和本报告中的身份，近期实现散列、精确测试名称、十一项函数范围与引用，以及完整96行汇总表。检查152处相对文件链接，无断链；函数身份无重复，git diff --check 通过。未宣称旧函数散列或全仓历史报告全部是当前版本。

最近代码完整回归为3760项：3669通过、91条件跳过、0失败；此处引用[远程 IDE 检查](2026-11-08-remote-ide-stability.json)，不冒称本次重跑全套。此前[斜杠帮助检查](2026-11-08-slash-help.json)和[浏览器兼容检查](2026-11-08-ide-link-compatibility.json)保留各自版本与环境边界。

dd2c627部署后已有的现场证据：85份待投递结果仍保留；连续10次正确CA的远端HTTPS请求均200、206–236毫秒；独立Chrome进入用户原项目code-server，首次约31秒。它们证明当次入口恢复，不等于所有浏览器或网络条件均已验收。浏览器证书信任与服务响应问题分开处理。

代码修复已部署头头和探探；本次文档提交推送即可，不需要为文档变化重启Gateway、Connector或原任务。探探及Herdr教程保留使用步骤和故障处理，不堆入内部性能修复日志；语雀教程沿用前次已同步的使用内容。
