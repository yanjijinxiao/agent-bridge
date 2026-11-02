# 单一原生协议与核心所有权

Gateway 的业务端口是 src/codex/backend.ts。CodexAppServerGateway 负责 host 路由与连接角色；AppServerCodexRunner 负责原生请求、通知与精确线程/轮次；daemon/remote-host/transport 只解决服务部署和连接。桌面和纯 CLI 的业务方法相同。自定义可执行文件名不决定是否创建私有核心。

## 事实源和生命周期

原生核心保存线程、队列、目标、执行权限和运行事实。Gateway 的主连接、元数据读连接、大历史读连接指向同一核心；读端口超时可以退休自身，但不停止执行核心。显式 stdio 是宿主拥有的私有连接，退出宿主会结束它，不具有独立 daemon 的重启保证。嵌入 Taskboard 借用 AccountManager 的原适配器，close 不拥有核心；独立 Taskboard 创建一个选定适配器，不启动 exec 回退。

普通续聊省略 nativeSettings 并继承已有 sandbox、审批策略和 reviewer。只有拥有设置的 UI 明确提交 nativeSettings 才覆盖。onApproval 回调存在不构成改权限的理由。thread/start/resume 的返回身份、turn/start 的接收、运行终态与投递状态分开；有界 RPC 超时不能结束一个已接收的长任务。

## 调用边界

新输入在最终写前调用 assertCurrent；续聊身份必须与 thread/read/resume 相同。onTurnStarted 持久接收身份以后，公共 item 才可更新该运行。停止必须使用精确 thread/turn；本地 close 只退休观察。runQueuedSubmission 用已保存原生回执核对，不带 prompt 重放。metadataOnly/historyOnly 连接有方法白名单，不能借只读身份写入。

模型、Skill、MCP 和额度来自原服务。Skill 以 name 和具体文件 path 组成选择身份，不能把不同 scope 的同名项合并；公开 item 映射过滤私有推理、审核器和 hook 内容，命令敏感值检查覆盖完整原串，再做长度裁剪。

## 直接验证

shared-app-server-integration、native-settings-integration、taskboard-native-integration 使用安装的原生二进制、临时 Home 和本机假模型。interaction-fanout、native-public-item 和 native-shared-catalog 覆盖原始请求范围、晚订阅、多消费者退休、异常/秘密字段及目录分页。NATIVE 系列列明具体行为范围；这些测试不证明所有供应商状态或实际手机界面均已验证。
