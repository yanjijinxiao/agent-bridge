# 0.6.0 发布后的文档核对

本次根据已发布的 0.6.0、现行源码及用户关于 Herdr 轮次的追问更新文档。仅修改说明和索引，没有修改运行逻辑、权限、状态格式或发布制品，不把这次文档检查算成全库重新逐行验收。

## 发现与修正

- 运行接口、Herdr 设计和 Peer 模块仍有“尚未 npm 发布”“头头保持原版”等现行状态描述，已改为链接到 0.6.0 的发行及部署证据。
- 运行模块的职责表仍写 Herdr 阶段保留，与单卡窗口模块冲突，已按实际调用链纠正；Codex 原生阶段逻辑保留。
- README 中英文、CHANGELOG、功能合同、模块说明和教程补充同一边界：Herdr 有状态和轮次相关计数，但正文读取没有逐轮索引；窗口可能包含旧问答，不保证只显示最后一轮。
- session 索引原先直接把读者指向历史 HDR-18 阶段分类用例，现明确由 2026-11-09 窗口合同与回归取代，不改写旧审计的 hash 或测试结果。
- 探探语雀教程仍写 npm 不包含 Herdr，并描述旧阶段卡。以仓库 Codex/Herdr 两份教程合并更新，保留共享 Gateway 地址、完整填写说明和分后端操作步骤；教程不增加固定版本安装要求或长更新流水。

## 四层核对范围

| 层次 | 本次依据与边界 |
| --- | --- |
| 架构 | Gateway / Connector / 原生执行器的职责不变；Codex 原生轮次与 Herdr 终端状态不混用；发行、上线和文档发布分别留证 |
| 模块 | 对照 App/TUI 输出、观察器、终端窗口展示、输入回执与 Peer 能力说明；教程和帮助的既有能力限制保留 |
| 文件和函数 | 重读 app.ts 的 read/send/资源映射、tui.ts 的 read/资源映射、runtime-observation.ts 的读后核验及 terminalScreen 调用、terminal-presentation.ts 的有界渲染；只纠正文档，不批量刷新历史函数记录 |
| 静态文件与配置 | 核对版本清单、发行证据、中文/英文 README、两份教程、CHANGELOG、文档入口和需求索引；检查相对链接、JSON 示例、代码围栏及语雀合并差异 |

上游依据使用既有固定快照：TUI ee5bfb5 的 src/api/schema/agents.rs、App 所用 core c6b316f 的 status.rs 和 api/types.rs。core.turn 在根状态离开 working 时递增，包含 blocked/error；TUI state_change_seq/completion_seq 是状态变化与完成转换信息。两套正文读取参数均没有 turn 选择器，不能据此声称有精确最后一轮读取能力。

## 既有 case 与验证范围

- test/terminal-presentation.test.ts：`terminal text retains commands, commentary, status and input without classification`，以及窗口预算与保留最新末尾的用例。
- test/agent-runtime.test.ts：`TUI reads bounded recent text, preserves truncation, never claims transcript`；`App read never scrolls the program or interprets terminal action blocks`。
- test/terminal-observation-presentation.test.ts：`terminal window replaces one card and recovers` 的 restart/stream/agent 矩阵。

以上精确用例用于核对说明与现有行为的对应关系；既有运行记录见 [窗口验证](2026-11-09-herdr-terminal-window/validation.json)。本次未修改实现或新增行为，不重复运行完整代码回归，也不将检查文档记成新的端到端通过记录。用户已接受当前终端窗口边界，没有新增最后一轮差分切片需求。

## 文档发布与制品边界

本次修订以仓库文档和在线教程为准。npm 0.6.0 tarball、v0.6.0 标签和已部署程序保持原发行身份，包内文档是打包时的快照；文档修订不冒充重新发布 npm 或重新部署。后续正式打包会自然带入更新后的公开文档。

- 本地静态核验：14 份 Markdown 文档的相对链接目标、代码围栏及 3 段 JSON 示例通过；git diff --check 通过。没有运行时文件改动，不要求服务重启。
- [探探语雀教程](https://aliyuque.antfin.com/odps/cm8be7/kfh7pk75ggvpno42) 已同步，回读 content_updated_at 为 2026-11-09T06:28:55.000Z。合并后的 Codex/Herdr 正文与本地准备稿一致（仅忽略语雀的空行、列表符号和代码语言标签归一化），原标题和目标文档不变。旧的“npm 尚未包含 Herdr”和阶段分类说明均已移除。
- [GitHub v0.6.0 说明](https://github.com/yanjijinxiao/agent-bridge/releases/tag/v0.6.0) 已修正 Herdr 能力表述并链接最新教程，回读正文与准备稿一致。没有修改 tag、制品或 npm 版本。
