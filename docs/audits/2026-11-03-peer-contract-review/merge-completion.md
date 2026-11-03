# Connector 合并候选：接口、范围和回归（2026-11-03）

目标基线是 `origin/main f108f81`，候选分支 `codex/gateway-peer-transport`。本检查点更新此前 cdb2540/2f4280e 的接口子集和实机记录；旧记录保留原日期与版本，不能作为本轮新代码已部署的证明。

## 完成范围

- 功能说明、模块文档、51个公共 facade 端口表、需求JSON、case表、实现索引和精选函数合同已同步。9个PEER场景只标记具体断言的窄边界；main原有106项partial没有被提升。
- 队列add/list/delete/run、容量/systemError恢复、Skills/MCP、诊断/provenance、原生设置、outputSchema、dynamicTools、新线程执行及独立交互已接入。版本协商明确拒绝旧Connector缺失的端口，不回退到Gateway本机。
- 队列回调在add返回后仍有效；删除确认为true、终态或断连才回收。删除false可能表示队列已开始消费，继续保留审批回调。source receipt按原操作者恢复，多用户同线程不混用。
- 后台恢复取得仍有效的具体来源及绑定守卫；设备侧反归档日志在断连/重建后继续履行恢复责任，不能据此启动推理。容量原始随机client ID在已授权的线程快照中恢复；普通用户队列ID仍按来源隔离。
- 本地/SSH端口参数、回调对象及receiver保持原样；修复了包装器getGoal漏传host的问题。省略设置保持原生权限；JSON空值恢复为facade的undefined。
- 空线程先创建原生元数据，保留订阅到首条输入；只对原生精确“未物化”错误加元数据核验，不把其他历史错误吞成空列表。首条输入之前不承诺跨服务重启持久化。
- 项目旧别名一致性只在Connector进程的 `withConnectorProjects` 投影。底层本地/SSH列表保持main行为；设备创建、worktree归属及导出的项目列表使用同一明确host/home映射，不按路径猜项目身份。

## 拆出的功能

`codex/session-lifecycle-commands` 是建立在本候选之上的独立待审分支：通用 `/session rename|archive|restore`、`/sessions archived`，以及Desktop归档目录和项目ID展示调整。它有自己的增量与说明，不包含在Connector候选的最终树中；后续合并需要独立产品/证据审查。

Connector保留原生管理端口和此前要求的资源所有者/共享文件页。机器人卡片、复制框、角色、审批/问答controller、主队列和结果投递继续复用原模块。`src/channels`及管理Web页面没有为Connector另写一套。

## 最终验证

| 验证 | 结果与边界 |
| --- | --- |
| 类型与构建 | `npm run typecheck`、Gateway/Taskboard完整构建通过；Connector构建后CLI `--help`可运行。保留现有Vite大块提示 |
| 完整根回归 | 2869项：2868通过、0失败、1项Windows专用跳过。实际Codex二进制和独立Chrome均开启 |
| 三种传输共用契约 | 21项（local/SSH路由/Connector各7项）包含在完整回归，使用同一原生JSONL协议夹具 |
| 真实SSH | 12环境7项全部通过；通过真实SSH进程和设备Node执行同一JSONL夹具，不冒充真实模型服务 |
| 真实Codex | 全量包含原生daemon、隔离本地模型、Connector断连/重载队列、六种普通输入SIGKILL场景；未调用生产模型 |
| 真实浏览器 | 独立Chrome 5项包含在全量，验证结果待投递、旧页重连、Taskboard开关和375px布局 |
| 项目投影收尾 | 私有投影类型保持调整后，1项原生JSONL测试、类型、构建及CLI重新通过；不改变运行逻辑 |
| 文档证据 | 319case均有测试映射；213窄边界通过、106保持partial；160条精选函数合同；校验无错误 |

其中唯一跳过项是 `prefers the npm CLI bundled beside node.exe on Windows`。上述测试数不相加，SSH与最后项目投影的重跑属于同一契约的额外环境验证。

复现命令：

```sh
npm run typecheck
npm run build
CODEX_NATIVE_QUEUE_TEST_BIN=/opt/homebrew/bin/codex \
CODEX_CHROME_TEST_BIN='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node --test --test-concurrency=4 --test-timeout=120000 --import tsx \
  --test-reporter=spec --test-reporter-destination=/tmp/peer-final-full.log \
  --test-reporter=./scripts/audit-test-reporter.mjs \
  --test-reporter-destination=/tmp/peer-final-results.jsonl test/*.test.ts
CODEX_CONTRACT_SSH_TARGET=admin@11.159.100.12 \
CODEX_CONTRACT_SSH_PORT=49178 \
CODEX_CONTRACT_SSH_NODE=/home/admin/tools/codex-node/bin/node \
node --test --test-concurrency=1 --test-timeout=60000 \
  --test-name-pattern='transport contract ssh' --import tsx test/backend-transport-contract.test.ts
node scripts/check-audit-evidence.mjs
```

机器证据见 `test-results-final.jsonl`；所选函数的main逐字比较与行号见 `function-delta-review.json`。未变化函数继承原窄场景；改变函数复核差异及调用边界，不以自动更新SHA冒充全仓库逐行审查。证据检查的 `in-progress` 保留main总体审查状态，不是本补丁测试失败。

## 发现与修复的反例

1. getGoal装饰器遗漏SSH host参数：三种非peer路由的参数引用/arity测试检出并修复。
2. JSON可选返回值变null、排队后的回调过早删除、删除false被误当已删除、多用户回执只按首个用户核对：新增明确反例和正常对照。
3. 原生新建空线程取消订阅后无法resume；未物化线程的turns/list报错：实际Codex进程复现，保持订阅并精确适配空线程。模型请求数和原生完成事实分开等待验证。
4. macOS临时目录的 `/var` 与 `/private/var` 表示使真实崩溃测试的绑定守卫误判；main隔离基线同样不能通过该用例。测试fixture统一realpath，保留生产绑定检查，六种真实SIGKILL恢复场景均纳入全量。
5. 最后拆分权限分支后，有一项测试仍检查已移出的rename命令；将通用命令及其测试一起保留到独立分支，当前用例核对viewer不能创建额外会话、原绑定不变。

## 合并与发布边界

本轮结论针对Connector传输与已列明的产品增量，可准备合入main；不承诺任何测试可以证明所有组合绝对零影响。默认不配置peer listener/client时不启动新网络入口；共享授权和写前守卫在启用后生效。

完整code-server（终端/Git/多根工作区）、Taskboard选择peer host、远端Channel启动入口仍是独立产品集成；当前共享文件编辑器不能冒充完整Web IDE。Windows实际进程/路径、所有IM供应商和手机展示、长期压力测试仍单列边界。

本轮没有重启或升级探探Gateway/Connector，没有重新发送真实钉钉消息。已有手机复制确认和DeepSeek实机证据继续归属于此前记录版本。本候选尚未推送、合并或部署；发布时继续使用先准备/检查/测试制品再切换的现有流程。
