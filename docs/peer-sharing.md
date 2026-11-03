# Connector 会话所有权与共享工作区

实验功能。自动化覆盖身份、资源权限和撤销；第二个真实用户及真实群聊尚需部署验收。共享文本页面不是完整 code-server IDE。

本功能在 Peer 设备配对上增加资源级授权。Connector 保存原生 thread 的所有者及委托记录；Gateway 的聊天 controller 角色不能直接领取所有权，也不能绕过该会话的 owner。Gateway 仍是受信任的 IM 身份、聊天角色与消息路由端，客户端不独立向钉钉校验每条 IM 消息。共享只负责准入指定资源；会话操作统一复用主分支的 `/role`，不再另设 `read / chat / control` 共享档位。

## 所有者与访问者流程

1. 所有者按 `gateway-peers.md` 配对设备并选择会话。
2. 发送 `/share claim`，在 Connector 终端确认钉钉账号和原生会话。若还要共享代码目录，使用 `/share claim --ide`，并在本机明确确认目录。第一次绑定、聊天角色和先到先得均不会自动产生 owner。
3. 所有者发送 `/share invite`，将返回的 `/join SH-…` 命令给访问者。邀请码只允许提交申请，24 小时有效，不是浏览器或执行凭据。
4. 访问者在希望使用的私聊或群聊发送该命令。尚未获得 Gateway 全局准入的用户也可以申请这个指定资源，不能借此查询 Gateway 本机目录或使用其他功能。
5. 所有者发送 `/share requests`，按真实申请 ID 批准，例如：

```text
/share approve 申请ID
/share approve 申请ID --ide read --hours 24
/share approve 申请ID --ide write --files --hours 8
```

6. 访问者重新发送原 `/join` 命令，绑定已授权会话；也可通过 `/sessions` 选择。访问者能否提交任务、停止和审批，由该聊天已有的 `/role` 决定。
7. `/share list` 查看授权 ID、身份、聊天、附加资源和到期时间；`/share deny 申请ID` 拒绝申请；`/share revoke 授权ID` 撤销委托。

授权期限为 1–168 小时，默认 24 小时，不会因重启自动续期。授权精确绑定机器人账号、用户、聊天、Connector profile 和原生 thread。owner 的身份按机器人账号 + 用户核对，不绑定单个聊天；owner 在新聊天操作前仍须完成已有设备配对。访问者在另一个群/私聊使用需要单独申请；群聊中的回复和历史对群成员可见。

## 能力与边界

会话所有者批准的是「这个人可以在这个聊天访问这个 session」，不能替代 Gateway 的角色管理。会话角色规则与 `main` 一致：

| 现有聊天角色 | 会话操作 |
| --- | --- |
| `viewer` | 查看历史、状态等，不提交任务 |
| `participant` | 另可续聊和介入 |
| `controller` | 另可停止、审批及管理会话和聊天角色 |

显式用户角色优先；已有全局准入用户默认 controller，其余按聊天默认角色，未设置时为 participant。只获得资源准入的访问者不能自己提升角色。已有 controller 在访问者所在聊天用 `/role 用户ID viewer|participant|controller` 设置角色；这个命令不会改变资源所有权、有效期或目录权限。不同用户在同一个群查看到的消息不构成彼此的资源授权。

Connector 校验身份、指定 thread、工作目录、有效期和撤销状态；Gateway 使用现有角色检查、审批控制器和执行前校验控制操作。controller 仍不能通过共享授权转授权、领取所有权、永久删除会话、新建其他会话或查询设备级账号信息。

文件与 Web 编辑器是独立资源，继续由所有者选择：

| 附加授权 | 能力 |
| --- | --- |
| `--ide read` | 只读浏览 owner 在本机确认的工作目录 |
| `--ide write` | 另可编辑该目录内已有文本文件；有文件版本冲突时拒绝覆盖 |
| `--files` | 另可通过 Connector 回传会话工作目录及其附件目录中的文件 |

不再提供 `--manage`；会话控制遵守 main 的角色检查。通用重命名、归档、恢复聊天命令已拆分，本分支不额外开放。会话聊天允许访问者驱动原生 Codex，执行能力沿用设备的 Codex 沙箱和审批策略；`--ide read` 只约束 Web 编辑器，不意味着 Codex 不能修改文件。具备本机操作权限的人仍能直接操作原生 Codex，这不是操作系统级多用户隔离。

### 升级兼容

Gateway 与 Connector 应配套升级，共享能力标识为 `sharing.version: 2`。写操作要求 `writeGuard: 1`，扩展原生端口要求 `nativeContract: 1`，独立交互要求 `interactions: 1`；缺失时明确提示升级。旧 Gateway 不支持新的共享能力标识。

旧 `read / chat / control` 委托保留在状态中，但不再用于准入、执行或浏览器访问，避免旧只读授权自动变为可续聊。资源所有者、目录确认和设备配对保留。访问者重新申请（原邀请码未过期时可复用），由所有者使用新的 `/share approve 申请ID` 明确批准。旧审批参数返回用法，不自动转换。

使用所有权功能时，本机配对状态升级为 version 2，并保留已有设备授权。旧 Connector 的数组格式解析会拒绝启动，避免降级后忽略私人会话策略；重新配对不会把状态降回旧格式。不能通过删除策略文件或改写格式回退权限。

领取为私人会话后，其他已经配对的普通设备用户不能直接读取、执行或从目录中看到它。

owner 与工作目录的变更需要本机再次确认；变更会撤销原委托和邀请。工作目录真实路径或目录身份改变时，旧授权失效，需要 owner 核对后重新领取。已运行任务不会因撤销委托自动终止；后续控制、回调、结果交付和浏览器访问拒绝继续使用旧委托。`/leave` 仅解除当前聊天绑定，不撤销委托。

## 共享 Web 编辑器

这是独立的受控文本工作区入口，复用 Peer 连接和 owner 委托。现有完整 code-server IDE 的本机/SSH 管理流程保持原样；Peer 的 `/ide` 返回此共享入口。它提供文件树、文本读取、只读/读写状态和保存，不提供终端、插件执行、通用代理或完整 VS Code 能力。终端没有可以被前端隐藏后绕过的后端接口。

在服务器的 Peer 配置中增加：

```json
{
  "listen": { "host": "127.0.0.1", "port": 9478, "devices": [{ "nodeId": "my-laptop", "tokenFile": "./my-laptop.token" }] },
  "resources": { "host": "127.0.0.1", "port": 9479, "publicOrigin": "https://workspace.example.com" }
}
```

反向代理只转发独立资源端口，保留 Host，不公开 Gateway 管理端口。也可为 `resources` 设置 `tls: { keyFile, certFile }` 自行监听 HTTPS。仅回环测试允许 HTTP；受控内网明文测试必须显式配置 `allowInsecureLan: true`。资源平面没有管理 API 或设备 Token。

访问者发送 `/ide` 后打开链接，浏览器显示 `/share browser 六位码`。在同一个已授权的机器人聊天发送该命令，再回原浏览器检查授权。链接和六位码均不是访问凭据：浏览器还必须持有自己的 HttpOnly proof Cookie，确认操作必须来自该委托对应的用户和聊天。

浏览器证明和会话复用主分支的 IDEAuthorization，默认上限为 90 天；访问者的资源授权更早到期时，浏览器会话同步到期，每次请求仍在 Connector 重新检查授权。入口与已批准的浏览器会话分别持久化到 Peer 配置旁的 .resources.json 和 .resources.json.sessions；重启不续期、不撤销现有授权，也不自动恢复已经撤销的资源。待确认申请仍为短时内存状态。Cookie 不放 URL，采用 HttpOnly、SameSite=Strict，HTTPS 下增加 Secure；API 验证 Origin、Host 和 CSRF，页面禁用第三方脚本、iframe 及内容执行。

目录边界通过真实路径和目录身份校验。拒绝路径穿越、符号链接、硬链接、二进制、特殊文件及超过 128 KiB 的文本文件；`.git`、`.ssh`、`.aws`、`.codex` 和 `.env*` 不在共享接口中开放。仅能保存现有文本文件，保存需要匹配当前内容摘要；冲突或撤销时保留浏览器中的本地修改，服务端不覆盖文件。

## 验证

```sh
npm run typecheck
node --test --test-timeout=20000 --import tsx test/peer-sharing.test.ts
npm test
```

专项测试使用真实回环 WebSocket 和 HTTP，覆盖本机确认、跨用户/聊天/机器人隔离、私人会话、现有聊天角色与审批、旧委托重新批准、授权过期、重启、运行中撤销、owner 更换、只读写入拒绝、路径越界、浏览器证明和 CSRF。原生 Codex 在自动化测试中使用模拟后端；实机结果另行记录，不将模拟访客视为真实的第二钉钉账号。

以下为权限收敛前的历史验收记录，不能代替新版本的访客验收。

2026-11-02 实机联调：Linux 容器 Gateway + Mac Connector + 探探私聊，在新建的独立测试目录完成本机 owner/目录确认、邀请生成、浏览器经钉钉确认后读取与保存文本文件，并在本机核对保存内容。Gateway/Connector 重启后 owner 保留，配对状态升级为 version 2 且保留原有配对。共享入口仅通过回环 SSH 隧道访问，未发布跨设备 HTTPS 入口；没有使用第二个真实钉钉账号验证访客流程。

独立 Chrome 测试覆盖桌面与手机宽度、只读/读写、保存、撤销后写入拒绝、文件内容不执行脚本、无页面错误及无横向溢出。最终全量测试 2219 项：2212 通过、7 跳过、0 失败；类型检查和 Bridge 构建通过。
