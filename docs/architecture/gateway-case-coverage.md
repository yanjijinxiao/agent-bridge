# 需求与 case 核对表

2026-11-05 最新展示增量：DEL-08.8–DEL-08.11 覆盖阶段说明保留、实时窗口、超长切卡、恢复状态、原圆点/图标/缩进，以及精确输入对应附件不被旧回执阻塞。见[阶段架构](phase-progress.md)、[阶段回归](../audits/2026-11-05-phase-progress.md)、[终态与排版回归](../audits/2026-11-05-terminal-progress-regression.md)。

命令展示密度 CAT-02.5 增量见[展示预算与原生目录范围核验](../audits/2026-11-05-command-density.md)：默认会话/项目50项、历史20条、准入/队列50条，权限范围保持原边界。

原生配置与设备自助登记增量：IDE-08.4、PEER-01.4，见[本次四层检查及命名用例](../audits/2026-11-04-native-config-enrollment/README.md)。旧汇总数字是对应历史检查点，不能代替增量证据。

由 gateway-requirements.json 汇总。verified 只证明其记录的具体边界；最新权限展示增量见[检查记录](../audits/2026-11-04-permission-visibility/README.md)。其他未完成范围沿用原清单。

Connector 省略 CA 的 PEER-01.3 增量见[证书检查与线上验证](../audits/2026-11-04-connector-ca/README.md)。

| 要求 | 模块 | 场景数 | 已记录窄边界通过 | 部分覆盖 | 未映射 |
| --- | --- | ---: | ---: | ---: | ---: |
| NATIVE-01 · 一套完整原生接口 | native | 5 | 4 | 1 | 0 |
| NATIVE-02 · 同一原生核心与权限继承 | native | 7 | 6 | 1 | 0 |
| NATIVE-03 · 全部控制按主机路由 | native | 7 | 5 | 2 | 0 |
| NATIVE-04 · 轻读与历史隔离 | native | 3 | 3 | 0 | 0 |
| NATIVE-05 · 线程和轮次状态正交 | native | 7 | 6 | 1 | 0 |
| NATIVE-06 · 长任务不因静默超时 | native | 3 | 3 | 0 | 0 |
| IN-01 · 普通消息透明转发 | inbound | 4 | 2 | 2 | 0 |
| IN-02 · 可靠接收与持久交接 | inbound | 9 | 8 | 1 | 0 |
| IN-03 · 未知前序不永久阻塞 | inbound | 4 | 4 | 0 | 0 |
| IN-04 · 群命令归一化 | inbound | 3 | 2 | 1 | 0 |
| IN-05 · 入站附件和引用 | inbound | 4 | 1 | 3 | 0 |
| IN-06 · 跨主机资源 | inbound | 6 | 3 | 3 | 0 |
| STATE-01 · 状态唯一与原子持久化 | state | 5 | 4 | 1 | 0 |
| STATE-02 · 账号生命周期和身份 | state | 4 | 2 | 2 | 0 |
| STATE-03 · 兼容迁移与私有数据 | state | 3 | 1 | 2 | 0 |
| BIND-01 · 未绑定与精确解绑 | binding | 3 | 1 | 2 | 0 |
| BIND-02 · 绑定是执行上下文权威 | binding | 5 | 3 | 2 | 0 |
| BIND-03 · 统一生命周期失效 | binding | 4 | 1 | 3 | 0 |
| BIND-04 · 主交互与来源路由 | binding | 3 | 2 | 1 | 0 |
| BIND-05 · 绑定总览 | binding | 3 | 3 | 0 | 0 |
| CAT-01 · 完整普通会话目录 | catalog | 6 | 6 | 0 | 0 |
| CAT-02 · 顺序、分页与稳定选择 | catalog | 5 | 5 | 0 | 0 |
| CAT-03 · 项目身份与创建 | catalog | 5 | 4 | 1 | 0 |
| CAT-04 · 历史与详情 | catalog | 4 | 3 | 1 | 0 |
| CTRL-01 · 普通忙时 steer | controls | 4 | 1 | 3 | 0 |
| CTRL-02 · Codex 原生持久队列 | controls | 4 | 3 | 1 | 0 |
| CTRL-03 · 队列恢复和取消 | controls | 5 | 4 | 1 | 0 |
| CTRL-04 · 停止及目标身份 | controls | 5 | 5 | 0 | 0 |
| CTRL-05 · 状态与帮助 | controls | 5 | 3 | 2 | 0 |
| AUTH-01 · IM个人和群准入 | access | 3 | 1 | 2 | 0 |
| AUTH-02 · 远程准入审批 | access | 5 | 5 | 0 | 0 |
| INT-01 · 原生审批全范围 | interactions | 8 | 8 | 0 | 0 |
| INT-02 · 真实审批与内部审核 | interactions | 5 | 4 | 1 | 0 |
| INT-03 · 提问、表单与安全URL | interactions | 5 | 4 | 1 | 0 |
| INT-04 · 答案及决定回执 | interactions | 4 | 4 | 0 | 0 |
| INT-05 · 异步状态不卡主线 | interactions | 3 | 2 | 1 | 0 |
| REC-01 · systemError自动恢复 | recovery | 4 | 3 | 1 | 0 |
| REC-02 · 容量恢复 | recovery | 5 | 4 | 1 | 0 |
| DEL-01 · 执行、送达和显示独立 | delivery | 8 | 6 | 2 | 0 |
| DEL-02 · 单卡分阶段持久化 | delivery | 4 | 3 | 1 | 0 |
| DEL-03 · 不追加文本兜底 | delivery | 3 | 2 | 1 | 0 |
| DEL-04 · 历史不当新任务 | delivery | 3 | 2 | 1 | 0 |
| DEL-05 · 分段而非任务完成 | delivery | 3 | 2 | 1 | 0 |
| DEL-06 · 最终参与者原生提醒 | delivery | 3 | 2 | 1 | 0 |
| DEL-07 · 长回答完整可读 | delivery | 3 | 2 | 1 | 0 |
| DEL-08 · 进展真实且简洁 | delivery | 11 | 8 | 3 | 0 |
| DEL-09 · Markdown语义完整 | delivery | 4 | 2 | 2 | 0 |
| DEL-10 · 复制按用户任务 | delivery | 3 | 1 | 2 | 0 |
| CHAN-01 · 四种IM统一前端 | channel | 4 | 2 | 2 | 0 |
| CHAN-02 · 网络生命周期有界 | channel | 3 | 3 | 0 | 0 |
| CHAN-03 · 媒体发送不误判 | channel | 10 | 10 | 0 | 0 |
| CHAN-04 · 轮询游标与重连 | channel | 5 | 3 | 2 | 0 |
| IDE-01 · 项目与worktree唯一入口 | ide | 4 | 4 | 0 | 0 |
| IDE-02 · 完整多根授权 | ide | 3 | 2 | 1 | 0 |
| IDE-03 · 本地远程就地运行 | ide | 5 | 4 | 1 | 0 |
| IDE-04 · 统一个人准入和90天 | ide | 3 | 3 | 0 | 0 |
| IDE-05 · 一次确认与原浏览器证明 | ide | 4 | 4 | 0 | 0 |
| IDE-06 · 已授权外链立即进入 | ide | 3 | 2 | 1 | 0 |
| IDE-07 · HTTP及WS实时复核 | ide | 3 | 3 | 0 | 0 |
| IDE-08 · 安装和Profile真正生效 | ide | 5 | 4 | 1 | 0 |
| IDE-09 · 入口地址及TLS协调 | ide | 5 | 4 | 1 | 0 |
| IDE-10 · 主机增量热接入 | ide | 3 | 3 | 0 | 0 |
| WEB-01 · 表单与刷新归属 | web | 10 | 8 | 2 | 0 |
| WEB-02 · 可选模块不阻塞核心 | web | 4 | 3 | 1 | 0 |
| TB-01 · 任务板可选集成 | taskboard | 9 | 7 | 2 | 0 |
| KB-01 · 知识库与QA边界 | knowledge | 5 | 4 | 1 | 0 |
| REL-01 · 重启仅保护Gateway交接 | release | 8 | 6 | 2 | 0 |
| REL-02 · 直接发布与真实制品 | release | 11 | 9 | 2 | 0 |
| AUDIT-01 · 四层职责和按行证据 | audit | 4 | 2 | 2 | 0 |
| TB-02 · 独立 AI 面板的实现职责 | taskboard | 11 | 9 | 2 | 0 |
| WEB-03 · 管理接口和静态资源的实际响应 | web | 2 | 2 | 0 | 0 |
| TB-03 · 议题与评论附件的实际界面 | taskboard | 5 | 5 | 0 | 0 |
| TB-04 · 事件处理器的执行授权与生命周期 | taskboard | 5 | 5 | 0 | 0 |
| TB-05 · 本地与云端任务接口契约一致 | taskboard | 3 | 3 | 0 | 0 |
| TB-06 · 议题人类可读编号的唯一性与稳定性 | taskboard | 1 | 1 | 0 | 0 |
| TB-07 · 议题日期的输入与呈现边界 | taskboard | 2 | 2 | 0 | 0 |
| TB-08 · 本地schema迁移保全业务字段 | taskboard | 1 | 1 | 0 | 0 |
| TB-09 · 异步议题写入的来源与部分成功 | taskboard | 9 | 8 | 1 | 0 |
| TB-10 · 工作流编辑与执行能力分开核验 | taskboard | 4 | 3 | 1 | 0 |
| TB-11 · 云迁移提交与补偿的独立事实 | taskboard | 4 | 4 | 0 | 0 |
| TB-12 · 议题键盘操作的合法性与单次交接 | taskboard | 2 | 2 | 0 | 0 |
| PEER-01 · 同一后端接口的 Connector 传输 | peer | 4 | 4 | 0 | 0 |
| PEER-02 · 配对、绑定与所有者准入 | peer | 2 | 2 | 0 | 0 |
| PEER-03 · 原生队列与恢复 | peer | 3 | 3 | 0 | 0 |
| PEER-04 · 设备文件与工作区边界 | peer | 3 | 3 | 0 | 0 |
| TB-13 · 列表读取与页面加载状态 | taskboard | 1 | 1 | 0 | 0 |
| IDE-11 · Connector完整IDE与设备权限 | ide | 6 | 6 | 0 | 0 |
| IDE-12 · IDE准备同页展示与失败恢复 | ide | 2 | 2 | 0 | 0 |
| IDE-13 · 个人浏览器一次确认与默认信任 | ide | 2 | 2 | 0 | 0 |
| IDE-14 · 明确启用的持链接直接进入 | ide | 3 | 3 | 0 | 0 |
| KB-02 · 移除 Gateway 自建长期记忆 | knowledge | 4 | 4 | 0 | 0 |
| CAT-05 · 个人当前 Connector 目录选择 | catalog | 4 | 4 | 0 | 0 |
| NAT-07 · Gateway 全部执行统一到 Connector | native | 11 | 11 | 0 | 0 |

当前共 427 个场景，343 项有列明边界的验证记录，84 项保留部分覆盖限制。本表仅汇总已有记录，不刷新历史验证结论。

2026-11-04 链接直达增量：IDE-14.1–14.3，3 个场景均有直接测试映射，5 个测试（含全新 Chrome）通过。启用账号可持链接进入；未启用账号保留 IDE-13 的本人确认。详见 [增量检查](../audits/2026-11-04-ide-link-access/README.md)。

## 2026-11-04 终态卡片补充

CTRL-03.3 / DEL-09.3 增补“同会话旧队列未映射且历史不可用，纯文字原生结果仍完成原卡；重复回执及重建不重新展示停止入口”。对应 `queue-result-recovery.test.ts` 的 plain-result、`compact-progress-design.test.ts` 的 unconfirmed historical 和 `dingtalk-progress-layout.test.ts` 的 HTTPS/SDK 状态转换。证据见[定向四层记录](../audits/2026-11-04-stale-terminal-card.md)；此增量不刷新既有全库覆盖数字或未经复查的文件哈希。

2026-11-04 增量：REL-02.11 的 HTTP 收尾及 GitLens 实际验证见 [验证收尾记录](../audits/2026-11-04-verification-boundaries/README.md)。历史总数不作为本次测试总数。

## Gateway 自建记忆移除（KB-02）

长期记忆由 Codex 管理，Gateway 只保留消息交接和明确业务状态。删除记忆注入、保存、命令与菜单；显式 llm-wiki 不属于此次移除。

| Case | 功能及异常合同 | 精确测试 |
| --- | --- | --- |
| KB-02.1 | 状态迁移、IM/Web/原生队列不注入、无菜单入口 | runtime-state、format、bridge-service、account-manager、queued-bridge-context |
| KB-02.2 | 旧混合动作继续发附件，纯记忆输出正常收尾 | actions、full-review-actions、queue-result-recovery |
| KB-02.3 | 旧序号 0–3 偏移、未知不重发、回滚兼容 | turn-result-actions |
| KB-02.4 | 12 个真实崩溃恢复场景核对附件字节和一次发送 | native-input-crash-recovery、native-queue-crash-recovery |

测试全名与内容散列以 gateway-requirements.json 为准；过程及验证边界见[移除记录](../audits/2026-11-04-remove-gateway-memory.md)。

## 2026-11-05 Connector 唯一执行入口

NAT-07.1–07.6：缺失路由拒绝、托管注册隔离、旧输入/队列回执、设备侧观察、完整项目目录、明确设备的临时推理；测试全名和本次文件散列记录在 gateway-requirements.json。另有同机/远端托管 IDE HTTP、WebSocket、多根目录用例，以及 managed-connector 的完整原生 JSONL 契约。真实迁移预检比较 2 个原生核心、25 个绑定和项目根目录，全部保持一致。完整回归 3291 项：3205 通过、86 条件跳过、0 失败；跳过不计作验证。本次是变更范围的四层检查，不刷新历史未复查文件的覆盖结论。

NAT-07.7–07.8 增补：托管 IDE 复用原实例目录，托管主机临时目录附件继续回传；个人设备不继承托管范围。精确测试及变更文件散列见 requirements；覆盖包括本机、远端、错身份、文件大小/类型和副本释放。此增量不改写历史总数。

NAT-07.10：单 Connector 多主机路由、权限与文件/IDE 检查见 [记录](../audits/2026-11-05-connector-host-routing.md)。
