# Agent Bridge npm 发布

产品包为 @yanjijinxiao/agent-bridge，GitHub 仓库为 yanjijinxiao/agent-bridge。根 package.json 的 version 是产品发布号的唯一手工来源；package-lock.json 同步记录它。Gateway 与 Connector 位于同一包，两个命令共用编译实现。没有另起 Connector 业务分支。

## 构建和安装边界

源码工作区保留 private: true，禁止在运行中的源码目录直接 npm publish。npm run package:npm 生成独立的可发布 package.json：复制产品元数据、依赖、bin 和版本，去掉 workspaces、开发依赖和生命周期脚本。安装者无需克隆仓库、构建网页或安装 Taskboard 工作区。

内嵌 Taskboard 位于 dist/vendor/codex-taskboard。编译入口只使用该制品，不回退到可变的源码工作区。旧 dist/node_modules 路径会被 npm 默认排除，不能作为发布布局。Taskboard 的内部独立包版本和上游 Codex 版本仍属各自领域，不伪装成产品发布号。

发布包只包含 dist、公开 README/LICENSE/CHANGELOG、两份 peer 配置示例及安装/连接说明。不会复制 .git、.npmrc、私有部署目录、账号配置、凭据、聊天状态和内部审计记录。包内公开 CA 用于固定 Gateway 的 TLS 信任，不包含私钥。

## 发布步骤

1. 先更新功能、模块、用例及注释；通过 npm version --no-git-tag-version 调整根版本，提交 package.json 和 lockfile。不另写 CLI 版本常量。
2. 完成 typecheck 与相关回归；准备目录必须是仓库外的新目录。构建不会改变线上 dist，也不会注入或重启 Codex Desktop。
3. 在干净提交上运行以下模板，替换输出目录：

```sh
npm run package:npm -- --out /absolute/new/release-directory
```

4. 使用输出 tarball 在独立前缀安装，确认两个命令的 help/version、Gateway /api/build、网页和内嵌 Taskboard 都能工作；不能依靠开发目录的 node_modules。
5. 核对 receipt.json 的版本、commit 和 integrity。对该版本建立 v 前缀 Git 标签，push 提交与标签。发布同一 tarball，不能重新打包另一个未验证产物。发布命令模板如下：

```sh
npm publish /absolute/release/package.tgz --access public --registry=https://registry.npmjs.org/
```

6. npm 可能要求账号的浏览器/双因素确认，凭据和验证码不能发到群聊。发布后从官方 registry 核对 name/version/dist.integrity、latest 标签，并用实际安装验证；发布成功不等于线上实例已经重启。
7. 部署时核对每个 Gateway/Connector 的 productVersion、commit、instanceId 和实际连接。状态、授权和原生执行器不随程序版本重置。

## 当前待发布候选

0.6.3 包含 Herdr 被动跟随去重、Codex 冷恢复权限保留，以及旧 App 会话展示分组和 Connector 项目筛选修复。待发布号不代表 npm latest 已更新。正式发布前应核对候选 receipt 与安装验证，发布后再从 registry 确认；不要把已上线的修复构建称为已发布 npm 版本。

此次 Codex 修复在 Connector 中执行，因此管理员需分别核对 Gateway 和受维护设备的程序版本。升级 Connector 保留其配置、设备身份、回执及 stateDir，只重启 Connector；无需为了更新转发程序重启 Codex、Herdr 或用户任务。

## 统一版本的含义

npm version = package.json version = CLI --version = build-info.productVersion = runtime.productVersion。Git 标签为 v 加相同版本，源码 commit 另行记录。HTTP、Peer、执行适配和日志 schema 的兼容版本独立演进；包发布不自动修改它们。

更新检查使用 scoped registry 路径，安装到隔离 prefix，再原位替换已退出实例的程序目录。路径识别同时支持 scoped 和旧 codex-im-gateway 安装目录，已有发布计划仍能恢复；旧状态目录、环境变量和 /api/build.product 的兼容标识保留。源码安装仍要求源码更新，不把目录名相似当作 npm 安装。

## 发布后暂时 404

npm 会在新版本可安装前进行发布扫描，因此发布命令成功和公开下载可用可能相隔数分钟。遇到 404 时先核对包的访问级别及维护者可见的版本状态，等待官方元数据与 tarball 可读，再核对完整性并安装；不要重复发布同一版本，也不要为绕过扫描随意增加版本号。状态显示 published 本身不能替代实际下载验收。参见 [npm 发布扫描说明](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/)。
