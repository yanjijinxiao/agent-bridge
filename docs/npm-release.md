# Agent Bridge npm 发布

产品包为 @yanjijinxiao/agent-bridge，GitHub 仓库为 yanjijinxiao/agent-bridge。根 package.json 的 version 是产品发布号的唯一手工来源；package-lock.json 同步记录它。Gateway 与 Connector 位于同一包，两个命令共用编译实现。没有另起 Connector 业务分支。

## 构建和安装边界

源码工作区保留 private: true，禁止在运行中的源码目录直接 npm publish。npm run package:npm 生成独立的可发布 package.json：复制产品元数据、依赖、bin 和版本，去掉 workspaces、开发依赖和生命周期脚本。安装者无需克隆仓库、构建网页或安装 Taskboard 工作区。

内嵌 Taskboard 位于 dist/vendor/codex-taskboard。编译入口只使用该制品，不回退到可变的源码工作区。旧 dist/node_modules 路径会被 npm 默认排除，不能作为发布布局。Taskboard 的内部独立包版本和上游 Codex 版本仍属各自领域，不伪装成产品发布号。

发布包只包含 dist、公开 README/LICENSE、两份 peer 配置示例及安装/连接说明。不会复制 .git、.npmrc、私有部署目录、账号配置、凭据、聊天状态和内部审计记录。包内公开 CA 用于固定 Gateway 的 TLS 信任，不包含私钥。

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

6. npm 可能要求账号的浏览器/双因素确认，凭据和验证码不能发到群聊。发布后从官方 registry 核对 name/version/dist.integrity，并用实际安装验证；发布成功不等于线上实例已经重启。
7. 部署时核对每个 Gateway/Connector 的 productVersion、commit、instanceId 和实际连接。状态、授权和原生执行器不随程序版本重置。

## 统一版本的含义

npm version = package.json version = CLI --version = build-info.productVersion = runtime.productVersion。Git 标签为 v 加相同版本，源码 commit 另行记录。HTTP、Peer、执行适配和日志 schema 的兼容版本独立演进；包发布不自动修改它们。

更新检查使用 scoped registry 路径，安装到隔离 prefix，再原位替换已退出实例的程序目录。路径识别同时支持 scoped 和旧 codex-im-gateway 安装目录，已有发布计划仍能恢复；旧状态目录、环境变量和 /api/build.product 的兼容标识保留。源码安装仍要求源码更新，不把目录名相似当作 npm 安装。
