# 真实渠道与浏览器验收

2026-11-08。早期报告只有生产入口子进程和捕获式 IM 适配器，不能算探探端到端。此后已补下面的真实链路；早期报告保存在 before-e2e 检查点。

| 范围 | 实际链路与结果 | 边界 |
| --- | --- | --- |
| Herdr TUI | 钉钉 → 探探 → Linux12 Connector → Herdr TUI/Codex CLI → 原卡片；输入、回执恢复、进程骤停、最终展示已验 | 不覆盖所有 TUI agent 的中断键 |
| Herdr App | 钉钉 → 探探 → Mac Connector → 同一 App/core 实际 Codex PTY → 卡片；附件缓冲及 Gateway/Connector 骤停已验 | App 安装与执行接口都已验证；不把空欢迎页当作执行验收 |
| Codex CLI/App | 两端独立原生会话，读写、审批、附件、steer、queue、停止、运行中重启均已验 | 详见 native-compat-e2e.md；只操作本轮测试线程 |
| Mac IDE | 真实项目链接；创建并保存测试文件；终端 pwd/cat/git status；Source Control 变更徽标；刷新后编辑器和终端恢复 | 用户已处理证书警告 |
| Linux IDE | 保存 README 标记；终端 pwd/cat；Git Open Changes 差异；刷新恢复 | 测试容器补装 Git，制品与持久 HOME/PID namespace 有记录 |
| 卡片展示 | 真实钉钉桌面观察：阶段成果、分段最终正文、命令摘要、IDE；终态无停止控件 | 当前模板无原生点击折叠，/history 查看当前终端详情 |

手机不是 IM 或浏览器核心验收的通用前提。真实多人跨群、移动布局和所有浏览器组合没有被这份记录认证。测试计数、隔离协议测试和真实平台结果分别列出，不相互替代。

探探私聊原绑定及目录选择已恢复。头头与用户原任务未重启；Codex 原生服务始终独立运行。当前部署/推送状态见 production-verification.json。
