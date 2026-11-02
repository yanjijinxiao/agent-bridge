# Connector 会话所有权与共享工作区

本功能在 Peer 设备配对上增加资源级授权。Connector 保存原生 thread 的所有者及委托记录；Gateway 的聊天 controller 角色不能直接领取所有权，也不能绕过该会话的 owner。Gateway 仍是受信任的 IM 身份与消息路由端，客户端不独立向钉钉校验每条 IM 消息。

## 所有者与访问者流程

1. 所有者按 `gateway-peers.md` 配对设备并选择会话。
2. 发送 `/share claim`，在 Connector 终端确认钉钉账号和原生会话。若还要共享代码目录，使用 `/share claim --ide`，并在本机明确确认目录。第一次绑定、聊天角色和先到先得均不会自动产生 owner。
3. 所有者发送 `/share invite`，将返回的 `/join SH-…` 命令给访问者。邀请码只允许提交申请，24 小时有效，不是浏览器或执行凭据。
4. 访问者在希望使用的私聊或群聊发送该命令。尚未获得 Gateway 全局准入的用户也可以申请这个指定资源，不能借此查询 Gateway 本机目录或使用其他功能。
5. 所有者发送 `/share requests`，按真实申请 ID 批准，例如：

```text
/share approve 申请ID read --ide read --hours 24
/share approve 申请ID chat --ide write --hours 8
/share approve 申请ID control --hours 1
```

6. 访问者重新发送原 `/join` 命令，绑定已授权会话；也可通过 `/sessions` 选择。只读访问者可绑定和看历史，不能提交任务。
7. `/share list` 查看授权 ID、身份、聊天、能力和到期时间；`/share deny 申请ID` 拒绝申请；`/share revoke 授权ID` 撤销委托。

授权期限为 1–168 小时，默认 24 小时，不会因重启自动续期。授权精确绑定机器人账号、用户、聊天、Connector profile 和原生 thread。owner 的身份按机器人账号 + 用户核对，不绑定单个聊天；owner 在新聊天操作前仍须完成已有设备配对。访问者在另一个群/私聊使用需要单独申请；群聊中的回复和历史对群成员可见。

## 能力与边界

| 授权 | 能力 |
| --- | --- |
| `read` | 指定会话元数据、历史与状态；不开放其他会话、模型目录或账号额度 |
| `chat` | 另可向该会话发送任务和插话；不自动获得原生审批权 |
| `control` | 另可停止任务及处理本轮原生审批；不包括转授权、永久删除或所有权变更 |
| `--ide read` | 只读浏览 owner 在本机确认的工作目录 |
| `--ide write` | 另可编辑该目录内已有文本文件；有文件版本冲突时拒绝覆盖 |
| `--files` | 另可通过 Connector 回传会话工作目录及其附件目录中的文件 |
| `--manage` | 另可重命名、归档和恢复指定会话；不包括永久删除 |

委托权限还受聊天角色限制。单纯通过资源授权进入的访客默认角色由其能力推导；有明确聊天角色时继续遵守该角色。真正的能力检查发生在 Connector，不能通过提高 Gateway 聊天角色扩权。

使用所有权功能时，本机配对状态升级为 version 2，并保留已有授权。旧 Connector 的数组格式解析会拒绝启动，避免降级后忽略私人会话策略；重新配对不会把状态降回旧格式。升级后的 Gateway 和 Connector 应配套使用，不能通过删除策略文件或改写格式回退权限。

领取为私人会话后，其他已经配对的普通设备用户不能直接读取、执行或从目录中看到它。具备本机操作权限的人仍能直接操作原生 Codex；这套授权不是操作系统级多用户隔离。授予 `chat` 允许访问者驱动原生 Codex，执行能力沿用本机 Codex 沙箱和审批策略，不是只读代码权限。

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

浏览器会话最多 1 小时，资源授权更早到期时立即失效；每个请求在 Connector 重新检查授权。Cookie 不放 URL，采用 HttpOnly、SameSite=Strict，HTTPS 下增加 Secure；API 验证 Origin、Host 和 CSRF，页面禁用第三方脚本、iframe 及内容执行。资源入口重启后需重新获取链接并确认浏览器，不保留旧浏览器凭据。

目录边界通过真实路径和目录身份校验。拒绝路径穿越、符号链接、硬链接、二进制、特殊文件及超过 128 KiB 的文本文件；`.git`、`.ssh`、`.aws`、`.codex` 和 `.env*` 不在共享接口中开放。仅能保存现有文本文件，保存需要匹配当前内容摘要；冲突或撤销时保留浏览器中的本地修改，服务端不覆盖文件。

## 验证

```sh
npm run typecheck
node --test --test-timeout=20000 --import tsx test/peer-sharing.test.ts
npm test
```

专项测试使用真实回环 WebSocket 和 HTTP，覆盖本机确认、跨用户/聊天/机器人隔离、私人会话、审批分权、授权过期、重启、运行中撤销、owner 更换、只读写入拒绝、路径越界、浏览器证明和 CSRF。原生 Codex 在自动化测试中使用模拟后端；实机结果另行记录，不将模拟访客视为真实的第二钉钉账号。

2026-11-02 实机联调：Linux 容器 Gateway + Mac Connector + 探探私聊，在新建的独立测试目录完成本机 owner/目录确认、邀请生成、浏览器经钉钉确认后读取与保存文本文件，并在本机核对保存内容。Gateway/Connector 重启后 owner 保留，配对状态升级为 version 2 且保留原有配对。共享入口仅通过回环 SSH 隧道访问，未发布跨设备 HTTPS 入口；没有使用第二个真实钉钉账号验证访客流程。

独立 Chrome 测试覆盖桌面与手机宽度、只读/读写、保存、撤销后写入拒绝、文件内容不执行脚本、无页面错误及无横向溢出。最终全量测试 2219 项：2212 通过、7 跳过、0 失败；类型检查和 Bridge 构建通过。
