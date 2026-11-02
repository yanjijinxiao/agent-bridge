# Taskboard 工作流编辑与保存

WorkflowBoard 负责项目流程文档的编辑和持久化；shared/workflow-control-flow.mjs 负责结构合法性、树操作和布局；server/cloud 的 workflow-workspace 接口负责版本化存储。画布节点存在并不证明该 kind 已具备执行器。App 中原本隐藏的节点入口保持原有设置，不能通过打开入口或改测试假装完成所有执行能力。

## 结构权威

V2 canonical flow 是有序 sequence，首位是触发器；condition item 自有 true/false 两个 sequence。计划节点的 parentId 子项属于其容器，不进入根 sequence。视觉边与虚拟插入点从 canonical flow 推导，不能反向把条件树展平成连线列表。服务端拒绝重复节点、重复触发器、错类型及引用父级计划子项的 flow。

根步骤在原 sequence 内垂直排序；condition 移动整个 item，两个分支及后代一起保留。触发器固定首位。计划子项只在原计划内排序。pointerdown 记录抓取偏移，drop 使用最终指针坐标决定 canonical 插入位置，不能使用上一帧 preview。条件后代的移动只是画布预览；预览期间不自动保存临时坐标，放下后重新 derive 布局。

## 读取、冲突与项目切换

getWorkflowWorkspace 完成前禁用流程操作，避免迟到加载覆盖用户对默认文档的编辑。每个项目有独立组件实例、远端版本、串行保存队列及 mounted lease。旧项目成功仍保存原项目，但不把旧回执应用到新项目画布。Capability 返回也检查 abort，不把旧目录的列表带到新项目。

保存使用服务端 version 的 CAS。等待中的更新会合并为最新序列化快照，旧 queued payload 不覆盖新编辑。只有已确认回执才显示“已自动保存”；dirty/saving/failed 各有准确状态。

VERSION_CONFLICT 保留本地画布并暂停自动保存，读取远端只用于展示冲突选择。“保留本地并保存”以已观察远端版本再次CAS，若又冲突继续保留；“载入远端版本”才明确放弃本地投影。不能偷偷拿最新 version 覆盖其他写者。当前仍没有跨页面关闭的完整本地工作流草稿恢复，不作此承诺。

## 直接验证

实际 Chrome 渲染生产 WorkflowBoard、React Flow、CSS及API，HTTP替身控制延迟、CAS冲突。覆盖正常保存、两种冲突选择、加载期间禁止编辑、旧项目保存后切新项目、根步骤/条件树/计划子项排序及触发器固定。保留原失败日志。工作流静态旧断言未修改，完整 Taskboard 回归409项通过；浏览器专项后续48项通过。没有据此宣称真实云端任意丢回执、所有 palette 执行与手机端已验证。
