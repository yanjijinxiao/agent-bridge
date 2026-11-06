# 2026-11-06 Agent Bridge 名称与 npm 发行核对

范围：GitHub 改名、安装入口、版本单源、npm 更新器、编译资源、README 和探探教程。本次是改动范围的四层检查，不宣称重新逐行审查全仓。

## 四层记录

1. 架构：一个包两个进程入口，同一份执行/协议实现。产品版本来自根清单；协议、日志兼容版本保持独立。品牌变更不搬迁状态和设备身份。
2. 模块：CLI 的 help/version 不启动服务；npm 更新器识别 scoped 和旧安装；候选制品激活/回退只操作程序；Taskboard 固定跟随编译制品，源码和部署隔离。
3. 函数：检查 publicationManifest/packageNpm、resolveNpmInstallTarget、npmCandidateRoot/readNpmRelease、Taskboard 导入和 gatewayAdapterUrl。对应 contract 记录和 case 已更新。
4. 静态与配置：README 中英文、语雀和本地探探教程、Web 标题/图标标题/仓库链接、package/lockfile、发布清单、两份配置模板及 Taskboard Web 一并核对。旧环境变量、协议 product 标识、动作块和私有路径保留。

## 验证

- TypeScript 检查通过。
- Gateway 全量 3392 项：3303 通过、88 跳过、1 项旧品牌断言失败。该用例里的旧标题与仓库地址更新后，HTTP 全部 23 项重新通过；npm 及任务板打包相关用例亦通过。未把第一次失败报告改写成全绿。
- Taskboard 全量 502 项：500 通过、2 跳过。
- npm 制品在独立全局 prefix 实际安装，依赖 131 项；没有借用仓库 node_modules。
- 两条 CLI --help/--version、Gateway /api/build、管理网页、Taskboard /health、构建 JS 资源请求均通过。测试使用随机本机端口和独立临时状态，没有重启生产实例或 Codex daemon。
- tarball 共 904 文件，核对包含管理网页、内嵌 Taskboard、两条 CLI 和构建清单；没有私有部署状态、.npmrc、凭据文件或内部审计目录。

## 发布回执

- 产品包：@yanjijinxiao/agent-bridge，版本 0.5.0，Git 标签 v0.5.0。
- 代码提交：9faaf9a3c3bcabc691f479745917323c1c6436e3。
- npm integrity：sha512-MQ3Y2tuV9e8SP/Q6E7uHoY4JGnj6syZd2XjOZfV6kfvDGf+j4xvm+sI48SnMRK0Vm3qPW56eWzRICTCfhwPW5A==。
- GitHub 仓库已改名为 yanjijinxiao/agent-bridge，并已推送 main 和标签；origin 已同步。
- 首次 registry 发布因缺少 2FA 返回 403。用户开启并完成本次浏览器验证后，npm publish 返回成功；2026-11-06 12:33 UTC 官方元数据确认 name/version/integrity 与上述制品一致，访问级别 public，latest=0.5.0。
- 发布后短暂出现 404；通过维护者状态接口核对 published 后，继续等待公开元数据及 tarball 可用，没有重复发布。GitHub v0.5.0 已从草稿转为正式发布。
- 本轮没有切换生产 Gateway/Connector；npm 包的安装版本与在运行的旧进程版本必须分别核对。

## 官方 registry 安装验收

用户已完成本次发布的浏览器 2FA。维护者状态接口确认 published，npm access 确认为 public，latest 指向 0.5.0。公开元数据于 12:33 UTC 可读，tarball 于 12:36 UTC 下载成功，2,289,912 字节的 SHA-512 与原验证制品完全一致。

随后从官方 registry（不是本地 tarball）安装到独立临时 prefix，共安装 131 项依赖。两条 CLI 的 help/version、Gateway 真实启动和 /api/build、管理页、Taskboard /health 及构建静态资源全部通过。产品版本 0.5.0、代码提交 9faaf9a3c3bcabc691f479745917323c1c6436e3 一致。没有重启线上服务。

正式入口：[npm 包](https://www.npmjs.com/package/@yanjijinxiao/agent-bridge)、[GitHub v0.5.0](https://github.com/yanjijinxiao/agent-bridge/releases/tag/v0.5.0)。首次发布扫描造成的暂时不可下载已结束，不再属于待完成事项。
