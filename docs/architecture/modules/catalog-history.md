# 项目目录、别名与公开历史

原生 project/list 与 thread/list 是当前身份/归属事实；Desktop 注册表提供已知旧别名、主机及展示信息。mergeCodexProjectCandidates 不能因为主目录相同而隐藏两个不同原生 ID。已知旧别名只在明确的 host/home 命名空间映射到原生 ID，保留原管理项目及 IDE 稳定身份；其他同目录原生项目仍显示。

## 新建与继续

prepareTurnSubmission 携带所选项目的完整 projectRoots。resolveProjectId 先使用明确存在的原生 ID；未知 ID 不再按 cwd 选中另一个项目。当前 Desktop 注册表中的已知旧 ID 可以用明确映射，或以完整根集合唯一翻译；两个匹配报歧义。没有现有项目时 project/create 提交全部根，幂等键包含主机、旧身份和全根集合。已有线程续聊继承原生 membership，不借创建 hint 迁移它。

完整 rootPaths 与执行 cwd 不相同：cwd 是入口位置，根集合才描述项目范围。不可用的兄弟目录不能悄悄从展示成员中消失；真正授权仍由 IDE/原生执行边界检查。

## IM 会话目录展示

CAT-02.6：旧 App 会话可能有显式 App 项目分组，但尚无原生 projectId。设备侧 `desktop-catalog-groups` 只读当前注册表和已发布 App 目录：同 host 的显式归属、已登记旧项目、缺少 membership-host 同步标记，且每个现存 stable/dev 目录都确认该 host/thread 可见，才提供展示候选。备份、cwd、侧栏顺序、已同步或明确无项目记录均不构成候选；多个 App 目录不一致时不猜选账户。原生 thread/list 仍决定会话是否存在及持久状态。

候选只在 `listSessionCatalog` 中投影为既有 workspaceProjectId；明确旧别名优先，否则要求完整根集合唯一匹配同 host 原生项目，已删除别名和歧义不补。投影后再按项目筛选及限量，Connector 设备目录的二次过滤保留同一展示分组，项目可跨 worktree。原生 `listThreads`、`inspectThread` 和 unassigned 仍按原生归属；委派会话只查精确授权线程的原生事实。绑定重新 inspect，IDE 仍要求 assigned 原生项目，展示候选不进入执行缓存或持久权限。CLI 无 App 数据维持原路径，异常保留原生行并提示展示不完整。见[实现、反例与验证](../../audits/2026-11-11-legacy-catalog-grouping.md)。

目录入口先按 [当前 Connector](connector-selection.md) 解析本人当前聊天的持久来源。默认查询、搜索和项目目录使用该来源；显式 all 聚合，显式 --host 临时筛选，翻页沿用快照。卡片标明实际 host，切换使本人旧目录失效；缓存和异步返回仍检查角色与设备授权。目录偏好不参与普通输入的执行路由。

`handleSessionCatalog` 先取得未归档普通会话和原生项目目录，再由 `orderSessionCatalog` 固定会话顺序和 R 编号。`sessionCatalogItems` 是纯展示投影：置顶区 → 按原生目录排列的项目及缩进会话 → 其他会话。项目来自完整项目目录，不再以“当前有会话”为出现条件；仅有归档会话的项目也显示“暂无未归档会话”。所有成员已在置顶区显示时明确提示，不重复会话，也不误报为空。目录缺失时保留已有可读结果及警告，不根据 cwd 虚构项目身份。

会话和项目默认每页 50 项；会话已保存的 5–50 项偏好仍有效。命令展示预算集中在 `channels/command-display.ts`，不用于限制原生发现或扩大权限。公开历史默认 20 条，准入及队列回执一次最多 50 条并提示总量；渠道字节预算另行分片。

原生 thread/list 在目录分页和按 ID 补查中均显式使用 modelProviders=[]；模型供应商切换不能隐藏旧会话。普通 sourceKinds 筛选继续排除内部子任务。某个主机失败时保留其他主机的结果，明确标为部分结果，并给出连接准备或原生接口失败的安全原因。远端行展示实际原生主机及其经过的 Connector 名称，不把 Linux 会话标成本机 Mac。CAT-01.7 的隔离用例和现场边界见 [本地目录排查](../../audits/2026-11-06-connector-local-catalog.md)。

分页单位为会话或空项目占位项，项目标题不单独占项，避免大量空项目产生无限长卡片。跨页项目重复显示标题；只有实际会话获得稳定 R 编号和绑定按钮。详情、翻页及修改每页数量沿用同一份按人隔离的 15 分钟快照；项目占位不消耗 R 编号、不创建项目、不切换绑定、不启动任务。搜索和无项目过滤不附带无关空项目；当前项目过滤只显示原主机/项目身份。主机离线、目录未同步完整和项目 unavailable 与真正空目录分别提示。同名项目和跨主机身份完整区分，长标题为展示压缩，详情保留原值。

`session-catalog-tree` 的 Bridge 命令夹具覆盖空/归档/仅置顶、空项目跨页和稳定远端绑定、离线/部分目录、过滤及全空目录；既有排序和分页回归仍保留。DingTalk Markdown 适配结果通过本机断言，不代替手机端实际显示验收。

渠道 `structuredCards` 只声明静态卡片展示能力，不声明原生按钮可点击。钉钉配置模板时，项目树与表格都走卡片发送器，含必要的完整回复控件；否则沿原有文字回退。长卡按既有 UTF-8 预算分片，部分投递或未知回执不重新投递已发送页面。真实共享 Client → DingTalk 适配器夹具验证2/8/50个长项目，8个项目不会误用文本回退的小容量拆卡；50个长项目保持有界卡片和全部 R 项。不能只测 Bridge 捕获到的 card.body 就宣称真实渠道已验证。

## 历史及观察

metadata-reader 与 history-reader 隔离轻读/重读。rollout-identity 过滤内部审核和子线程继承，历史终态不能推翻权威 active 状态。CodexSessionCompletionMonitor 只是低延迟 hint，启动 baseline 和 emitAfter 防止旧完成当成新消息。观察器逐块读文件；单条记录最多 8 MiB，超长未完成记录只保存 discard cursor，直到真实换行再恢复后续公开事件。普通 UTF-8 片段完整组装后才解析。

codex-projects、native-project-membership、codex-app-server、codex-session-monitor 与 history 相关测试提供具体证据。项目同目录不同 ID、全根创建和未知明确 ID 有原版失败反例；长记录预算有实际 Buffer.concat 监测及后续正常进展/完成对照。旁路不是第二个执行器，丢弃过大 hint 不构成任务失败。

## 公开用户消息的共同边界

public-user-message.isInternalUserMessage由原生history、rollout history与Desktop预览共用，只匹配已知完整环境/中断信封及特定审批transcript前缀。普通用户正文引用这些标签不被隐藏。内部thread来源仍由rolloutIdentity单独判断，不能仅靠删正文证明子线程隔离。CAT-04.1/2补齐三种日志格式、UTF8长行、正常引用和两条reader路径。新建提前thread ID与干净标题经真实隔离原生核心验证。

目录展示时间按Date可表示范围验证；有限数字仍可能超出该范围。项目沿原缺省时间策略，session省略无效的可选updatedAt；不删除条目、不修写原生数据库、不改变项目/主机身份。CAT-01.5有正常时间与原文件字节对照。

CAT-01.6 将同一可表示日期边界补到原生 App Server DTO：thread.updatedAt 与 turn.startedAt 的极大有限值不再令读取失败；秒和毫秒仍兼容，原生数据不改写。
