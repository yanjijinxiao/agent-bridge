# 项目目录、别名与公开历史

原生 project/list 与 thread/list 是当前身份/归属事实；Desktop 注册表提供已知旧别名、主机及展示信息。mergeCodexProjectCandidates 不能因为主目录相同而隐藏两个不同原生 ID。已知旧别名只在明确的 host/home 命名空间映射到原生 ID，保留原管理项目及 IDE 稳定身份；其他同目录原生项目仍显示。

## 新建与继续

prepareTurnSubmission 携带所选项目的完整 projectRoots。resolveProjectId 先使用明确存在的原生 ID；未知 ID 不再按 cwd 选中另一个项目。当前 Desktop 注册表中的已知旧 ID 可以用明确映射，或以完整根集合唯一翻译；两个匹配报歧义。没有现有项目时 project/create 提交全部根，幂等键包含主机、旧身份和全根集合。已有线程续聊继承原生 membership，不借创建 hint 迁移它。

完整 rootPaths 与执行 cwd 不相同：cwd 是入口位置，根集合才描述项目范围。不可用的兄弟目录不能悄悄从展示成员中消失；真正授权仍由 IDE/原生执行边界检查。

## 历史及观察

metadata-reader 与 history-reader 隔离轻读/重读。rollout-identity 过滤内部审核和子线程继承，历史终态不能推翻权威 active 状态。CodexSessionCompletionMonitor 只是低延迟 hint，启动 baseline 和 emitAfter 防止旧完成当成新消息。观察器逐块读文件；单条记录最多 8 MiB，超长未完成记录只保存 discard cursor，直到真实换行再恢复后续公开事件。普通 UTF-8 片段完整组装后才解析。

codex-projects、native-project-membership、codex-app-server、codex-session-monitor 与 history 相关测试提供具体证据。项目同目录不同 ID、全根创建和未知明确 ID 有原版失败反例；长记录预算有实际 Buffer.concat 监测及后续正常进展/完成对照。旁路不是第二个执行器，丢弃过大 hint 不构成任务失败。
