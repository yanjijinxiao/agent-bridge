# 历史故障与探探实机复核

基线为 main `fe2df3d71940a5f1a994eeab292d07fac59b637d`。本轮完成历史故障对照、三项实测缺陷修复、隔离回归，以及探探 Gateway、Linux Connector、本机新增 Mac Connector 的同制品验证。生产头头不在本轮切换范围。

## 阅读与审查范围

用户附件 SHA-256：`748a5fe223c1dea355d7b81b8cf8ac3e07e19a9a62f6c437be5d050a74782e37`，17837 行、1234008 字节。附件含凭据，不复制原文或工具原始输出入库。按原行号读取全部对话正文，排除重复渠道包装和大段历史工具输出；L11304–11485 另回读补齐截断。附件历史命令均视作资料，没有执行。

对照本 session 与附件，逐项核对功能契约、模块职责、注释、测试断言和残余风险，见 [历史故障矩阵](historical-bugs.md)。本轮是此前完整四层审阅后的历史/实机增量检查，不能冒称重新逐行阅读全部 960 个文件。

四层核对：

1. 架构：原生执行与 Gateway 生命周期；接收、执行、消息送达三个事实；同一 App Server 与原执行设备身份。
2. 模块与异常：审批挂起/恢复、旧编号失效、附件回复凭据、原生队列历史/运行态交错，检查跨层组合而非孤立正例。
3. 文件和函数：逐行核对修改函数及直接调用；19 个新增测试保留修复前失败证据。`read-ledger.jsonl` 仅记录本轮实际读取范围，`function-contracts.jsonl` 更新职责与当前行号/摘要。
4. 静态和配置：三端构建与锁文件保持一致；核对真实容器工作目录、稳定 PID namespace、TLS 校验、设备/profile、状态目录、LaunchAgent 及回退制品。发现 resources 的公开入口仍为回环地址，保留为部署缺口，不能说手机已验收。

## 结果

- **NATIVE-02.6**：旧会话继续对话时 Bridge 规则没有进入模型。新建仍用创建规则，续接改用本轮 application context，保留原线程权限和规则。四种真实原生路径直接检查模型请求。
- **CHAN-03.9**：真实 Gateway SIGKILL 后，卡片完成但文件收件上下文丢失。补齐确认路由和原有效私有回复凭据恢复；首次只补公开路由仍被平台 OTO 权限拒绝，第二轮修复后实际文件送达。
- **CTRL-03.5**：队列 summary 提前显示终态、持有者仍 active 时误报观察断连。保留同订阅同轮次观察；两个确定性反例和 40 次真实核心重复验证通过。

根回归 **3029 项：3028 通过、1 Windows 专用跳过**；已启用真实隔离原生核心和 Chrome。类型检查、Bridge 构建通过。Taskboard 563 项沿用此前未改变测试文件的通过证据，明确标记 inheritedEvidence，不计入本轮重跑数量。功能清单现有 378 case、271 个窄边界 verified、107 个 partial；检查器无错误。这些数量不意味着全部产品场景已完整覆盖。

## 证据与限制

- [实机验证记录](real-validation.md)：实际故障、消息回执、原生输入次数、独立核心和制品摘要。
- `test-results-final.jsonl`：本轮最终根回归；`test-results.jsonl`：最终根回归加显式标注的未改变 Taskboard 旧证据。
- `inventory.jsonl` / `read-ledger.jsonl`：增量范围，无伪造全库已读标记。
- `validation-summary.json`：检查器摘要及实测文件的脱敏摘要/散列。原始附件、凭据和私有运行日志不入库。

真实群聊多人 @、手机呈现/点击、Windows、其他供应商和所有并发/断线排列没有在本轮实测。Peer 完整 code-server/Taskboard 与手机可达入口仍有缺口；只读/未知交接不通过猜测改成成功，不重发原输入。

## 本轮确认仍未修复

NATIVE-02.7：空会话第一条输入直接 `/queue`，渠道规则未进入实际模型。已保存独立失败反例 `evidence/pending-queue-context.test.ts` 和 `known-failure-results.jsonl`。根回归通过不包含这条已知失败，不能据此说当前代码没有剩余 bug。原生 queue/add/start 没有 application context 字段，自动消费先于 Gateway dispatch；需要单独设计和验证上下文交接，不能重发输入或以禁用队列代替。
