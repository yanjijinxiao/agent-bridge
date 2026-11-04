# 探探与 Linux CLI Connector 真实钉钉验证

> 这是当时版本的验证记录，保留原测试步骤与结果。当前接入方式请以 [Connector 连接指南](gateway-peers.md) 为准：新设备自动生成身份，探探固定入口可省略 CA；本文旧设备凭据和证书步骤不作为新的接入要求。

验证日期：2026-11-02。分支：`codex/gateway-peer-transport`。

本轮将分支 rebase 到 `origin/main` 的 `57d8b2f`，并部署到实际的探探机器人。与 [此前的 Linux 实机测试](peer-linux-cli-validation.md) 不同，本轮使用真实钉钉 Stream 收消息、真实钉钉私聊收发消息和附件；通过已登录的 `dws` 用户身份发送测试请求，并用事件订阅取得探探的实际回复。

## 部署与运行时

```text
钉钉私聊「探探」
  → 29：tantan-gateway-test
  → 29：TLS frontend（宿主端口 49186）
  ← 12：linux12-codex-connector-20261102 主动建立 WSS
  → 12：原生 Codex daemon / 持久 CLI thread
```

- Gateway SSH：`admin@11.158.199.29:49187`。
- Connector SSH：`admin@11.159.100.12:49178`。
- Peer 地址：`wss://11.158.199.29:49186/gateway/v1/peer`，设备显式校验测试 CA；应用请求没有经过 Mac 中继。
- 12 使用独立 Node `26.12.0` / Codex CLI `0.163.0`，保留系统安装。两个实测原生线程的 `turn_context` 中模型均只有 `deepseek-v4.1-flash-1017`。
- 原生 daemon 在设备侧独立运行；本轮 Connector 替换前后 daemon PID 均为 `9955`。
- Gateway 继续使用原有账号状态目录，保留原有设备授权和会话。新增 `linux12` 的独立设备凭据；没有复制模型密钥到 Gateway。
- 初次真实切换的 HTTP / 发布闸门就绪耗时约 4 秒；审批修复版本替换耗时约 2 秒。制品、依赖、冒烟检查均在停止实际服务前准备完成，旧容器保留用于回滚。

## 实际私聊结果

下列消息 ID 均来自实际钉钉事件。时间为北京时间。最初文字、文件及取消审批验证部署版本为 `34e1077`；最终审批修复版本为 `e487bab`。

| 验证 | 证据 / 结果 |
| --- | --- |
| 配对 | 设备终端确认实际账号、私聊和操作者后授权；17:01:03 回复 `msgUukf7ULF2nk9wqp64mFyAA==`，仅提示成功及主动查询方式，没有输出全部会话 |
| 主动列目录 | `/sessions --host peer:linux12:headless` 返回实际设备目录，消息 `msg5sGHL8KByKk6Kf2cWcCUEA==` |
| 按编号绑定 | `/session R1` 绑定“Linux CLI Connector 接续测试”，消息 `msgTD2Ik45z1PeUmyVsYrVJKg==`；同一原生 thread 的既有历史也返回私聊 |
| 实际工具调用 | 私聊要求读取已知合成测试文件，17:03:59 回复 `TANTAN-LINUX-REAL-OK-34E1077` 与正确首行；消息 `msgkRHKZEcl++7u+B/ULx+2uQ==` |
| 附件入站 | 用户身份发送 36 字节合成文本，12 实际接收文件与源文件逐字节一致，模型随后正确识别内容；回复 `msgpefVJuTqLHtj3YfFU32j9A==` |
| 附件回传 | 私聊请求原样回传该文件，17:08:06 取得文件消息 `msg3ohcflxJvKYr12S6OUBHYA==` 及成功标记消息 `msg15h151WhAxRI2JJGXz9wkg==`；Gateway 同轮记录 `delivered` |
| 原生审批取消 | 只读原生会话触发 A1；按实际支持的 `/approve A1 cancel` 取消，钉钉收到中断结果，设备上确认目标文件不存在 |
| 延迟批准一次 | A3 于 17:25:48 到达，约 2 分 37 秒后才提交批准；17:28:30 收到原生确认 `msgVK3yuwhnlMN3CSnlLHY29Q==`，17:28:34 收到完成标记 `msgBr5HMHTOBnVcFU/Vjm93lw==`；设备目标文件与预期内容完全一致 |
| 退出与重绑 | `/leave` 回复 `msgazUtbHAG3c9yQyOSOMFB5w==`；检查状态为已解绑、当前会话为空。随后无需重新配对即可绑定原 CLI thread，回复 `msg20rhkaP+F9Pnpcf24ZSzTQ==`，设备授权保持有效 |
| 最新版本最终往返 | 恢复正常 thread 后，17:31:13 收到 `TANTAN-LINUX-FINAL-OK-E487BAB`，消息 `msgHlvuAff0ZjiHsuQRg2DzaQ==` |

附件名称：`roundtrip-real-34e1077.txt`。源文件和 Connector 入站文件的 SHA-256 均为：

```text
efc8bfdeedec209045f4b85ad4546d86ce2d761d311c2008a70c83add444b7a9
```

钉钉消息查询在本账号下只返回回传文件的名称，未提供可供 `dws` 资源下载使用的 `mediaId` / `fileId`。因此本轮确认了实际文件消息投递与设备入站字节一致，**没有完成从钉钉再次下载回传附件后的 SHA-256 校验**。

## 测试发现与修复

1. `34e1077` 保留主分支的目录树和空项目分页，同时从所选 Connector 拉取对应的设备项目；Gateway 重启时，保留尚未注册设备的既有订阅意图，不回退到 Gateway 本机执行。
2. 实际 A2 审批发现：渠道提示的审批期限为 10 分钟，Peer 回调却在 2 分钟后超时。该次批准没有执行，测试文件不存在；随后通过真实 `/stop` 清理原生轮次，没有自动重新发送模型请求。
3. `e487bab` 将交互回调的传输期限与执行租期对齐，由渠道控制实际审批 / 问答期限；连接关闭仍会释放等待。并在单次操作内恢复 JSON 传输前后的交互请求对象关联，使原生确认能关联原审批通知和后续展示。
4. 新增跨实际 WebSocket 的回归：审批和问答分别等待 3 分钟后仍能提交；原生回执关联同一请求，审批日志与继续展示获得确认。

最终代码检查：`npm run typecheck`、`npm run build`、`npm test` 均通过。全量 2626 项测试中，2602 通过、24 跳过、0 失败；定向 Peer 交互 / 共享 / 传输测试 35 项全部通过。

## 留存与边界

- 正常测试 thread：`01a19b25-5fa7-7333-b4d1-5d553936898e`，工作目录 `/home/admin/gateway-connector-linux-test/workspace`。
- 收尾状态：探探私聊绑定上述正常测试 thread，host 为 `peer:linux12:headless`；真实账号状态 `running`，Gateway、TLS frontend、Connector 均在运行。临时冒烟实例已停止。
- 独立只读审批 thread：`01a19b83-0b02-7d40-96c9-5822935d98b6`。
- 最终运行制品为两端的 `releases/peer-real-approval-20261102`，SHA-256：`fdbfa018ccd5b2e9cc10851ab046f61d41d39ba0176c79a8a334453742e2a263`。
- Gateway 保留旧容器 `tantan-gateway-before-approval-fix-20261102`；12 保留旧 Connector 容器 `linux12-codex-connector-before-approval-fix-20261102`。回滚代码时不恢复旧的授权 / 会话状态快照。
- 本轮实际 IM 验证覆盖一个真实用户与探探私聊，以及审批的文本命令；没有实测第二个真实用户、群聊或卡片按钮点击。
- 当前 TLS 是有 IP SAN 的 14 天测试证书，约于 2026-11-16 到期。长期运行需更新证书及设备 CA 配置。
