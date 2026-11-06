# GitLens 实际项目安装核对

用户反馈截图中的行末作者和提交详情没有出现在 Web IDE。原 IDE-08.5 在隔离环境通过，但当时审计明确记录 productionExtensionsChanged=false。当前线上本机 codex-channel-bridge 多根工作区、远程 odps_src_-_1 和 odps_src_-_2 三个实例实际都只有 Emacs 扩展。把兼容性测试说成用户已经能用，是本次交付缺口。

## 处理与边界

- 在上述三个现有实例的原生扩展目录安装官方 GitLens 19.5.0，保留 Emacs 0.111.6；没有更换共享初始基线或实例身份。
- 复用此前核验的官方 GitHub VSIX；安装前及远程传输后检查长度与 SHA256。源与摘要见 evidence.json，这不是独立发布签名。
- 备份原设置，仅补缺失的 Current Line、Hovers、整行悬停设置及关闭升级提示，保留已有显式设置和 JSONC。
- 未重启 Gateway、Connector、Codex 或 IDE；没有撤销授权，没有连接 GitHub/GitLab 账号，也没有给其他用户或新项目强制安装扩展。

## 四层增量核对

1. 架构：GitLens 是 code-server 原生扩展；Connector 只负责既有传输。安装结果属于项目实例，不能从一个主机或隔离测试推及所有项目。
2. 模块：核对 profile 初始安装与原生扩展管理的分工。修改共享基线会更换实例并影响当前 IDE，因此此次使用原实例的安装入口。
3. 文件与函数：读取 manager 的实例身份、transport 的扩展安装回执及设置保留逻辑、peer/ide-service 的受管实例 ID 复用；补装后用各实例实际 CLI 清单确认。没有修改业务源码，无新增实现镜像测试。
4. 静态与配置：实际线上三份扩展清单和设置已核对；更新 Web IDE 使用文档、探探教程和模块合同，明确“支持、已安装、已激活”三个边界。

## 验证证据

三个现有项目均由对应 code-server CLI 返回 eamodio.gitlens@19.5.0 和 tuttieee.emacs-mcx@0.111.6。本机实际 Web IDE 经 Gateway 现有维护入口打开，在真实 README.md 第 1 行显示行末作者和时间；原生悬浮详情显示提交标题、短哈希 71f407d、原/新代码差异。git blame 对同一行返回 71f407d91ce04b7b7e46ec6bed881b319ee833b5，标题相符。没有新建测试 Git 提交。

本机此次是实际浏览器验收；远程两个项目此次只完成安装清单及配置核验，不能称为远程浏览器或手机验收。GitLab Issue/PR 账号集成、付费功能及其他项目未验。既有 IDE-08.5 自动化用例仍保留隔离环境边界，此次没有重跑或计入此前全量回归数量。
