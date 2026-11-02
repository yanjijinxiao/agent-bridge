# Connector 分支复用审查

2026-11-02，重新 rebase 到 `origin/main b9d05bc`。保留 rebase 前完整备份分支 `codex/gateway-peer-backup-f63b581`。

## 已收敛

| 范围 | 处理 |
| --- | --- |
| 新建远程会话后的绑定 | 删除另一套 `createSession` / thread 赋值 / mode 切换 / 提示生成，调用既有 `bindCatalogSession`，统一归属校验、已有绑定复用和 follow 能力处理 |
| 项目目录 | 删除独立的 Peer 目录转换器，给既有 `projectCandidatesFromBackendCatalog` 增加主机上下文。远端路径仍禁止在 Gateway 本地 stat，远端目录仍不混入本机 Desktop 目录 |
| 会话选择 | 远程会话也使用主分支统一的 R 编号按钮格式，保留同一目录树、空项目、分页和复制命令生成 |
| 共享邀请 | 使用既有 `copyableChoices` 生成完整的申请 / 查看申请命令；复制不会提交申请或批准 |
| 浏览器确认 | 共享文本页面复用 `src/ide/copy-controls.ts` 的 `copyField`、脚本及样式；复制按钮不执行授权，仍需本人在原聊天确认 |
| 探探卡片 | 部署配置使用项目现有的标准模板常量和 `msgContent` 字段，通过现有管理 API 刷新账号；没有新增钉钉发送器或另做复制框 |

## 保留改动及原因

| 范围 | 必需性和复用边界 |
| --- | --- |
| `src/peer` 的连接、注册、RPC、回执 | Connector 主动连接、设备鉴权、按源消息去重、跨机结果和回调。主分支没有相同的设备传输接口；写请求不能在断线后盲目重发 |
| Backend facade | 本机继续调用原有 backend；选中 Peer 主机时转发相同的执行契约。使用原有 App Server、会话状态和工具实现，不另起模型代理 |
| Bridge 接入 | 保留配对和共享入口、主机路由、actor/chat 授权上下文、跨机附件落点。目录卡、历史、审批、结果投递均使用既有渠道流程 |
| 原生会话管理 | 设备侧创建、重命名和生命周期方法补齐接口；设备校验工作目录、空闲状态、授权和队列，不能依赖 Gateway 上的同名路径判断 |
| 审批 / 问答 | 原有 Controller 负责期限、选项和呈现。Peer 只负责传输等待及恢复序列化后的请求关联，不另实现审批 UI |
| 文件传输 | 复用相同附件和发送动作契约，增加跨机分块 / 校验 / 限额 / 作用域控制，保留设备本地路径与授权检查 |
| 所有者共享 | 保留此前要求的本人确认、按资源授权、撤销与浏览器绑定。Gateway 管理员身份不替代设备所有者授权 |
| 共享文本页面 | 保留受限文件读写适配。主分支 IDE 是 code-server 入口；直接替换会给只读访客开放更大的工作区执行面。完整 IDE 的安装、代理、终端和原有页面不复制到 Peer |

原有 `src/channels`（含钉钉渲染）、`src/web`、`src/ide`、审批与问答 Controller 相对本轮主分支没有分支修改。共享文本页是额外的受限资源界面，不能描述为已复用完整 code-server IDE。

## 验证口径

- 定向覆盖真实 WebSocket 的会话、文件、共享、管理和交互契约；也验证主分支项目转换与钉钉代码块。
- 共享页面复用复制框后，未确认的浏览器仍不能换取授权；错误聊天、CSRF、只读写入和撤销继续被拒绝。
- 真实钉钉验收要求同时核对实际卡片 create / deliver 回执和消息事件，避免把纯文本降级当作卡片成功。
- 自动化不能读取手机的剪贴板。设备端“点复制再粘贴”的体验需要实际客户端确认，接口和源码测试不替代此项。

## 本轮结果

运行版本 `950fadd`；制品 SHA-256 为 `462f4d8819c254c7d00f8f3c2a06dbe9514aa2344855cb68b57093c5eba28ec0`。两端运行目录为 `releases/peer-reuse-20261102`，实际 Gateway 切换约 4 秒，12 的原生 daemon 未重启。

类型检查和完整构建通过。定向回归 101 项通过；同步 rebase 后依赖并重新完整回归，2708 项中 2681 通过、27 跳过、0 失败。

真实钉钉结果：

- 标准模板 `02fcf2f4-5e02-4a85-b672-46d1f715543e.schema`，字段 `msgContent`。用户明确反馈“能看到，复制正常”，确认了真实客户端复制体验。
- 设备选择卡：`msgU/FJ6fNdU8EDbO+z/NsW4A==`；新版本会话目录卡：`msgbIn7idxQM6eXxz/0OzUeOQ==`。
- 同一张进度卡 `msgnPPqZbcqBGYmjxupvSh8+Q==` 更新为最终结果，精确消息查询包含 `TANTAN-CARD-REUSE-OK-950FADD` 和正确测试文件首行；卡片流式、最终状态均获钉钉回执。
- `/new --standalone` 实际创建并绑定原生 thread `01a19bb3-740b-7653-9871-9ab9f2048ced`，消息 `msgjaFMw3dKV43aP4+hpxJk2w==`；设备记录确认模型轮次为 0。随后仅归档该空测试会话，消息 `msga1ESRVKykq2/tBHDqnqDVw==`。
- A4 使用主分支原生审批卡，消息 `msg+2ObzYuEhdeQMcM4FcdmzQ==`；允许一次后原生确认 `msggBWFvn5UJYvo7ZBvJEYKow==`，完成卡 `msgKS3OK2sCeXkiV/VTYmRHXg==`，设备上的合成文件逐字节符合预期。

本轮没有再次覆盖第二个真实用户、真实群聊、完整 code-server UI 或手机卡片内的审批按钮点击；审批通过卡片提供的命令提交。
