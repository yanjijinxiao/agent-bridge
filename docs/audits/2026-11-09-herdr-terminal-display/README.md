# Herdr 终端阶段丢失与工具刷屏（历史实验）

本记录描述用户随后改变要求之前的解析器复现。该实现和对应测试已由[单卡终端窗口](../2026-11-09-herdr-terminal-window/README.md)替代；validation.json 的哈希和测试结果仅属于当时实验，不代表当前文件或当前验收。

基线：a4bd9f664e3beebddd869acf2d185542e7b51252。范围为 HDR-18 的截图回归和相邻展示链路，不能代替全仓四层检查或线上验收。

## 证据及原因

用户截图的红箭头指向助手正文「我会按 openai-docs 技能确认一下当前环境。」；下面是 Explored、Browsing、Searched、Opened 及带圆点的 Working。测试使用截图转录文本，不是生产 RPC 原始帧，不能据此断言截图时究竟发生过哪次滚屏。

旧代码可复现三种错误：Browsing/Opened 被记为助手成果；带圆点的 Working 被记为助手正文；输入缩进或滚出屏幕后，只选最后一个助手块，导致真实阶段被误判的状态块挤掉。另外，无圆点 Working 会过早固化仍在生成的正文。新增的 7 个解析测试在旧实现上全部失败，原有 9 个测试仍通过，说明旧测试没有覆盖这组真实格式。

修复将终端装饰先于内容分块识别；浏览工具只计入摘要；输入标记兼容 Codex 左边距；无输入行时按可见回复区间保留多个稳定阶段，并以 Worked for 分隔旧回复。Working 本身不证明正文已经完整。展示边界和原生 turn/交接身份仍严格分开。

## 四层检查

| 层 | 本次核对 | 结论及范围 |
| --- | --- | --- |
| 架构 | 原生 Codex typed item 路径、Herdr App/TUI read 返回值、RuntimeOutput、观察器到公共卡片 | 原生事件与终端推断是不同能力；本次不改执行入口、权限、协议、输入回执或任务终态 |
| 模块与场景 | projectTerminal、RuntimeObservationController、phase-progress、TurnPresentation/checkpoint | 稳定阶段归公共 checkpoint；工具只进入有界活动区；滚屏和恢复不删除已发布成果；未被观察到的文本无恢复保证 |
| 函数与代码 | 逐行检查终端投影文件；核对观察器调用、身份复核、去重及最终正文分支 | 新增装饰优先分类、输入左边距和回复区间逻辑；保留转义、未知 agent 降级与既有卡片组件；未声称逐行读完所有相邻文件 |
| 静态文件与文档 | 功能合同、模块说明、case 索引、Herdr 教程 | 明确只是画面推断；现有模板用摘要和 /history，不是原生点击折叠；未改配置、模板或 schema，无状态迁移 |

## 新增 case

| ID | 文件/测试名称 | 覆盖 |
| --- | --- | --- |
| HDR-18.R01–R03 | terminal-presentation.test.ts：Herdr browser screenshot keeps commentary and hides tool/status rows | 输入无缩进、有缩进、完全滚出画面；均只保留真实助手段，浏览工具计数为 5，不暴露工具全文或 Working |
| HDR-18.R04 | terminal-presentation.test.ts：scrolled frames keep all stable stages in the latest visible reply interval | 同屏多个阶段保留，已结束旧回复隔离 |
| HDR-18.R05 | terminal-presentation.test.ts：working decoration does not commit an incomplete streaming assistant paragraph | 普通/圆点/实心圆状态行不固化残缺正文 |
| HDR-18.R06 | terminal-presentation.test.ts：tool-only scrolled reply does not resurrect an older completed response | 最新区间只有工具时不回显旧成果 |
| HDR-18.R07 | terminal-presentation.test.ts：Codex prompt margin changes do not change its display identity | 左边距和 composer 不改变展示边界或隐藏结果 |
| HDR-18.R08–R09 | terminal-observation-presentation.test.ts：Herdr scrolled browser stages persist through redraw and card completion | 无重启/重建观察器及落盘账本；阶段出现一次，画面不再含正文时仍保留；运行卡有 IDE/stop，结束无 stop |

## 验证边界

具体命令、数量及源码哈希见 validation.json。原有终端、公共阶段卡、恢复、原生 item 及 Herdr 适配器相关回归一起执行。没有调用真实钉钉发送，没有重启 Gateway、Connector 或 Herdr，也没有将这次隔离测试记作探探/头头线上验收。

纯终端格式会随 CLI 版本和程序变化。Herdr 当前被核对的读取/观察接口提供终端文字、字节流和状态，并未给出与 Codex agentMessage/commandExecution 等价的事件。未来无损语义接入必须先验证实际原生会话来源、身份及只读能力；本次没有用另启执行器或改变会话写入权替代接口适配。
