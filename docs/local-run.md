# 本地运行指南 / Local Run Guide

Agent Bridge 提供 npm 发行包和源码两种安装方式。包名是 @yanjijinxiao/agent-bridge，包含 Gateway 和 Connector 两个独立启动入口；安装不会自动启动服务。

## npm 安装

Node.js 需为 22.x 的 22.13+，或 23.4+。安装与启动：

```bash
npm install -g @yanjijinxiao/agent-bridge
```

```bash
agent-bridge
```

只接入已有 Gateway 时无需启动自己的 Gateway；准备私有的 Connector 配置后执行以下模板：

```bash
agent-bridge-connector --config /absolute/private/path/peer-client.json
```

安装包已包含编译程序、管理网页和内嵌 Taskboard。Codex、code-server 是独立工具，按需要在执行设备安装，不由 npm 安装本包时自动启动或升级。

## 源码开发

```bash
git clone https://github.com/yanjijinxiao/agent-bridge.git
cd agent-bridge
npm ci
npm run build
node dist/server/index.js
```

管理页默认位于 http://127.0.0.1:8787，只监听本机。Gateway 不直接启动本机 Codex；通过 CODEX_IM_GATEWAY_PEER_CONFIG 配置设备监听，执行设备另行运行 Connector。

## 更新与后台运行

npm 手动更新：先停止自己运行的 Gateway 或 Connector，再运行 npm install -g @yanjijinxiao/agent-bridge，使用原配置启动。服务管理器必须继续使用原状态目录。Gateway 中已经由独立执行器接收的任务不因停止消息转发进程而被主动中断；不要停止 Codex daemon。

源码手动前台更新：先停止自己的进程，再执行 git pull --ff-only、npm ci、npm run build，然后启动。正在提供服务的 macOS LaunchAgent 使用[隔离发布流程](release-local.md)，不要在其 live dist 上运行 build。源码部署不开放管理页的 npm 自更新；npm 安装的实例使用候选目录准备及程序回退流程。

系统服务可运行 npm 安装后对应的 agent-bridge / agent-bridge-connector 可执行文件，或源码的 node /absolute/path/dist/server/index.js。全局 npm 更新后核对服务管理器仍指向当前安装入口。

以下配置保持兼容，不因品牌改名搬迁数据：

- CODEX_IM_GATEWAY_PORT：管理端口，默认 8787。
- CODEX_IM_GATEWAY_STATE_DIR：Gateway 私有状态目录。
- CODEX_IM_GATEWAY_OPEN=0：后台运行时不自动打开浏览器。
- CODEX_IM_GATEWAY_PEER_CONFIG：Connector 监听配置文件。
- 旧 CODEX_CHANNEL_BRIDGE_* 和 CODEX_WEIXIN_* 变量继续可用。

新 Gateway 默认使用 ~/.codex-im-gateway；若不存在，则复用已有 ~/.codex-channel-bridge 或 ~/.codex-weixin。不要删除或分享这些目录。Connector 始终保留原配置和 stateDir，以保留设备身份、授权和回执。

## 版本

agent-bridge --version 和 agent-bridge-connector --version 输出该安装包的产品版本，和 npm 版本一致；管理 /api/versions 可核对正在运行的各端，不把新下载的版本当成旧进程已更新。接口和日志兼容号独立管理。发布者参阅 [npm 发布流程](npm-release.md)。

## English

Install @yanjijinxiao/agent-bridge globally and run agent-bridge for Gateway, or agent-bridge-connector --config PATH to join an existing Gateway. The artifact includes compiled Web and embedded Taskboard assets. No service starts during installation. Preserve existing configuration, environment variables, state directories and device identities when upgrading. Source deployments use npm ci, npm run build and node dist/server/index.js; never rebuild the dist of a running managed service. Both CLI version commands and runtime productVersion match the npm package version.
