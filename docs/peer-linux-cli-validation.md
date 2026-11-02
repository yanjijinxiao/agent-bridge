# Linux CLI Connector 实机验证

验证日期：2026-11-02。代码版本：`cee736f`。

## 环境与边界

- Gateway：`11.158.199.29`，独立测试容器 `linux-connector-gateway-qa-20261102`。
- Connector：SSH `admin@11.159.100.12:49178`，容器 `linux12-codex-connector-20261102`。
- 应用链路：Connector 主动直连 `wss://11.158.199.29:49186/gateway/v1/peer`。使用独立设备凭据、含宿主机 IP SAN 的测试证书及显式 CA 校验，没有经过 Mac 转发。
- 两端采用当前分支的实际 `BridgeService`、Peer 协议及原生 App Server 适配器。IM 出口为记录消息和文件摘要的 DingTalk 格式适配器，**未连接实际钉钉 Stream，也未切换探探或修改其已有绑定**。
- 测试证书有效期 14 天。长期部署应更换证书及相应 CA 配置。

## Codex 与运行时

12 环境原有系统 Node 23.7.0 / Codex 0.166.0 保留。另安装独立 Node 26.12.0 / Codex 0.163.0，与 29 已验证版本一致：

```text
/home/admin/tools/codex-node/bin/node
/home/admin/tools/codex-node/bin/codex
/home/admin/.local/bin/codex-update
```

默认提供方为 `aliyun_maas`，模型为 `deepseek-v4.1-flash-1017`，使用与 29 一致的 Responses 接口及命令式认证助手。登录后的 `codex` 指向独立安装；CLI 测试没有通过 `--model` 覆盖默认值。原生线程的 `turn_context` 中观察到的模型只有 `deepseek-v4.1-flash-1017`。

原配置备份在 `/home/admin/.codex/backups/linux-connector-20261102/`。凭据文件权限为 `600`，不包含在本报告或测试构建包中。

## 实测结果

19 项跨机断言全部通过，另完成 CLI 普通回复、文件工具执行和 `codex exec resume` 三项实测。

| 范围 | 验证结果 |
| --- | --- |
| 配对与目录 | 本地确认后获得指定测试身份的授权；`/connect` 不查询或展示完整目录；主动 `/sessions` 才发现真实 CLI 会话 |
| 现有会话 | 绑定既有 CLI thread，通过 Gateway 接续，读取原有上下文与工作目录文件 |
| 默认模型 | Gateway 的测试默认模型未覆盖设备 DeepSeek；原生线程元数据也确认了实际模型 |
| 双向接续 | Gateway 产生的历史可由同一 thread 的 `codex exec resume` 继续读取 |
| 源消息幂等 | 同一源 ID 返回相同 turn ID，原生轮次数不增加 |
| 文件 | Gateway 上传 → Connector 文件落盘 → 模型实际读取并写文件 → Gateway 下载及渠道文件出口；两端 SHA-256 一致 |
| 权限边界 | 未配对身份查询被拒绝；所选工作目录以外的文件下载被拒绝 |
| 会话管理 | 重命名、归档目录、恢复并绑定相同 thread、新建独立持久会话；新建操作没有启动模型轮次 |
| `/leave` | 只解绑聊天，保留设备授权与原生会话；重新绑定可继续使用 |
| 原生审批 | 独立只读会话使用当前请求支持的 `cancel`，原生确认取消且文件不存在；`accept` 确认后才完成写入 |
| 中断 | 设备活动轮次被中断，返回原生失败回执 |
| Connector 重启 | 设备 daemon 保持同一进程并完成已开始的命令；重连恢复 thread、历史和授权；相同已接受源 ID 不重新执行 |

审批测试使用原生请求实际提供的选项。该实机请求没有提供 `decline`，不能用硬编码的 `decline` 替代其 `cancel`；不支持的选择会保留待处理请求，未自动放行。

## Linux 部署中处理的问题

1. 容器登录脚本在非交互 SSH 下也会提示读取 Idealab Key，最初读走了配置首行。已备份脚本并添加终端及 MaaS 配置检查，重新安装配置后验证了新登录默认模型。
2. 宿主 glibc 为 2.17，官方 Node 使用独立兼容运行库容器；系统 Node 未替换。
3. Codex 控制 socket 是指向 `/tmp/codex-daemon-505/` 的符号链接。仅挂载 `~/.codex` 不够，还需挂载真实 socket 目录。启动脚本通过设备容器的 Docker overlay 路径定位该目录，并共享设备 PID namespace。
4. 原生 daemon 在设备容器内运行，独立于 Node Connector 容器。这样停止或重启 Connector 不会结束原生任务。

## 留存位置

两端测试根目录均为 `/home/admin/gateway-connector-linux-test/`。

- 两端结果：`linux-connector-results.json`，不含凭据。
- 12 配置：`peer-client.json`；可复用启动脚本：`start-connector.sh`。
- 12 CLI 证据：`evidence/`；测试工作目录：`workspace/`。
- 原生接续线程：`01a19b25-5fa7-7333-b4d1-5d553936898e`，名称为“Linux CLI Connector 接续测试”。

这些结果覆盖真实 Linux 模型、工具、文件、会话与跨机 Peer 链路；不代表实际钉钉卡片、第二个真实用户或生产 HTTPS 域名也已在本轮验证。
