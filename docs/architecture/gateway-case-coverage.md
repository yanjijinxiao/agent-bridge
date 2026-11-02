# 需求与 case 核对表

verified仅表示记录的窄边界通过；partial不是完整验收；failed表示已确认反例尚未修复。

| 要求 | 模块 | 场景数 | 窄场景通过 | 部分覆盖 | 已失败场景 | 未映射 case |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| NATIVE-01 · 一套完整原生接口 | native | 5 | 3 | 2 | 0 | 无 |
| NATIVE-02 · 同一原生核心与权限继承 | native | 5 | 2 | 3 | 0 | 无 |
| NATIVE-03 · 全部控制按主机路由 | native | 5 | 2 | 3 | 0 | 无 |
| NATIVE-04 · 轻读与历史隔离 | native | 3 | 3 | 0 | 0 | 无 |
| NATIVE-05 · 线程和轮次状态正交 | native | 4 | 3 | 1 | 0 | 无 |
| NATIVE-06 · 长任务不因静默超时 | native | 3 | 2 | 1 | 0 | 无 |
| IN-01 · 普通消息透明转发 | inbound | 4 | 2 | 2 | 0 | 无 |
| IN-02 · 可靠接收与持久交接 | inbound | 6 | 4 | 2 | 0 | 无 |
| IN-03 · 未知前序不永久阻塞 | inbound | 3 | 2 | 1 | 0 | 无 |
| IN-04 · 群命令归一化 | inbound | 3 | 2 | 1 | 0 | 无 |
| IN-05 · 入站附件和引用 | inbound | 4 | 1 | 3 | 0 | 无 |
| IN-06 · 跨主机资源 | inbound | 3 | 0 | 3 | 0 | 无 |
| STATE-01 · 状态唯一与原子持久化 | state | 5 | 4 | 1 | 0 | 无 |
| STATE-02 · 账号生命周期和身份 | state | 4 | 2 | 2 | 0 | 无 |
| STATE-03 · 兼容迁移与私有数据 | state | 3 | 1 | 2 | 0 | 无 |
| BIND-01 · 未绑定与精确解绑 | binding | 3 | 1 | 2 | 0 | 无 |
| BIND-02 · 绑定是执行上下文权威 | binding | 4 | 2 | 2 | 0 | 无 |
| BIND-03 · 统一生命周期失效 | binding | 4 | 1 | 3 | 0 | 无 |
| BIND-04 · 主交互与来源路由 | binding | 3 | 2 | 1 | 0 | 无 |
| BIND-05 · 绑定总览 | binding | 3 | 3 | 0 | 0 | 无 |
| CAT-01 · 完整普通会话目录 | catalog | 4 | 4 | 0 | 0 | 无 |
| CAT-02 · 顺序、分页与稳定选择 | catalog | 4 | 2 | 2 | 0 | 无 |
| CAT-03 · 项目身份与创建 | catalog | 5 | 4 | 1 | 0 | 无 |
| CAT-04 · 历史与详情 | catalog | 4 | 3 | 1 | 0 | 无 |
| CTRL-01 · 普通忙时 steer | controls | 3 | 0 | 3 | 0 | 无 |
| CTRL-02 · Codex 原生持久队列 | controls | 3 | 1 | 2 | 0 | 无 |
| CTRL-03 · 队列恢复和取消 | controls | 4 | 2 | 2 | 0 | 无 |
| CTRL-04 · 停止及目标身份 | controls | 5 | 4 | 1 | 0 | 无 |
| CTRL-05 · 状态与帮助 | controls | 3 | 1 | 2 | 0 | 无 |
| AUTH-01 · IM个人和群准入 | access | 3 | 1 | 2 | 0 | 无 |
| AUTH-02 · 远程准入审批 | access | 3 | 2 | 1 | 0 | 无 |
| INT-01 · 原生审批全范围 | interactions | 8 | 8 | 0 | 0 | 无 |
| INT-02 · 真实审批与内部审核 | interactions | 4 | 3 | 1 | 0 | 无 |
| INT-03 · 提问、表单与安全URL | interactions | 5 | 4 | 1 | 0 | 无 |
| INT-04 · 答案及决定回执 | interactions | 4 | 2 | 2 | 0 | 无 |
| INT-05 · 异步状态不卡主线 | interactions | 3 | 2 | 1 | 0 | 无 |
| REC-01 · systemError自动恢复 | recovery | 4 | 3 | 1 | 0 | 无 |
| REC-02 · 容量恢复 | recovery | 4 | 3 | 1 | 0 | 无 |
| DEL-01 · 执行、送达和显示独立 | delivery | 7 | 5 | 2 | 0 | 无 |
| DEL-02 · 单卡分阶段持久化 | delivery | 3 | 2 | 1 | 0 | 无 |
| DEL-03 · 不追加文本兜底 | delivery | 3 | 2 | 1 | 0 | 无 |
| DEL-04 · 历史不当新任务 | delivery | 3 | 2 | 1 | 0 | 无 |
| DEL-05 · 分段而非任务完成 | delivery | 3 | 2 | 1 | 0 | 无 |
| DEL-06 · 最终参与者原生提醒 | delivery | 3 | 2 | 1 | 0 | 无 |
| DEL-07 · 长回答完整可读 | delivery | 3 | 2 | 1 | 0 | 无 |
| DEL-08 · 进展真实且简洁 | delivery | 6 | 3 | 3 | 0 | 无 |
| DEL-09 · Markdown语义完整 | delivery | 4 | 2 | 2 | 0 | 无 |
| DEL-10 · 复制按用户任务 | delivery | 3 | 1 | 2 | 0 | 无 |
| CHAN-01 · 四种IM统一前端 | channel | 3 | 1 | 2 | 0 | 无 |
| CHAN-02 · 网络生命周期有界 | channel | 3 | 3 | 0 | 0 | 无 |
| CHAN-03 · 媒体发送不误判 | channel | 6 | 6 | 0 | 0 | 无 |
| CHAN-04 · 轮询游标与重连 | channel | 3 | 1 | 2 | 0 | 无 |
| IDE-01 · 项目与worktree唯一入口 | ide | 4 | 4 | 0 | 0 | 无 |
| IDE-02 · 完整多根授权 | ide | 3 | 1 | 2 | 0 | 无 |
| IDE-03 · 本地远程就地运行 | ide | 3 | 2 | 1 | 0 | 无 |
| IDE-04 · 统一个人准入和90天 | ide | 3 | 3 | 0 | 0 | 无 |
| IDE-05 · 一次确认与原浏览器证明 | ide | 4 | 4 | 0 | 0 | 无 |
| IDE-06 · 已授权外链立即进入 | ide | 3 | 0 | 3 | 0 | 无 |
| IDE-07 · HTTP及WS实时复核 | ide | 3 | 3 | 0 | 0 | 无 |
| IDE-08 · 安装和Profile真正生效 | ide | 3 | 1 | 2 | 0 | 无 |
| IDE-09 · 入口地址及TLS协调 | ide | 4 | 3 | 1 | 0 | 无 |
| IDE-10 · 主机增量热接入 | ide | 3 | 3 | 0 | 0 | 无 |
| WEB-01 · 表单与刷新归属 | web | 6 | 4 | 2 | 0 | 无 |
| WEB-02 · 可选模块不阻塞核心 | web | 3 | 2 | 1 | 0 | 无 |
| TB-01 · 任务板可选集成 | taskboard | 4 | 2 | 2 | 0 | 无 |
| KB-01 · 知识库与QA边界 | knowledge | 4 | 2 | 2 | 0 | 无 |
| REL-01 · 重启仅保护Gateway交接 | release | 8 | 5 | 3 | 0 | 无 |
| REL-02 · 直接发布与真实制品 | release | 5 | 3 | 2 | 0 | 无 |
| AUDIT-01 · 四层职责和按行证据 | audit | 4 | 2 | 2 | 0 | 无 |
| TB-02 · 独立 AI 面板的实现职责 | taskboard | 7 | 5 | 2 | 0 | 无 |
| WEB-03 · 管理接口和静态资源的实际响应 | web | 2 | 2 | 0 | 0 | 无 |
| TB-03 · 议题与评论附件的实际界面 | taskboard | 4 | 4 | 0 | 0 | 无 |
| TB-04 · 事件处理器的执行授权与生命周期 | taskboard | 4 | 4 | 0 | 0 | 无 |
| TB-05 · 本地与云端任务接口契约一致 | taskboard | 1 | 1 | 0 | 0 | 无 |
| TB-06 · 议题人类可读编号的唯一性与稳定性 | taskboard | 1 | 1 | 0 | 0 | 无 |
| TB-07 · 议题日期的输入与呈现边界 | taskboard | 2 | 2 | 0 | 0 | 无 |
| TB-08 · 本地schema迁移保全业务字段 | taskboard | 1 | 1 | 0 | 0 | 无 |
| TB-09 · 异步议题写入的来源与部分成功 | taskboard | 5 | 3 | 1 | 1 | TB-09.5 |
| TB-10 · 工作流编辑与执行能力分开核验 | taskboard | 3 | 2 | 1 | 0 | 无 |
| TB-11 · 云迁移提交与补偿的独立事实 | taskboard | 3 | 3 | 0 | 0 | 无 |
| TB-12 · 议题键盘操作的合法性与单次交接 | taskboard | 2 | 2 | 0 | 0 | 无 |

81要求、305case；304有测试映射、199窄边界通过、105部分覆盖、1已复现失败且未补正式回归（TB-09.5）。原28项补测已映射；本次新失败分开记录。剩余范围见remaining-work.md。
