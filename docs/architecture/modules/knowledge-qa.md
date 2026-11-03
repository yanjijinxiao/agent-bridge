# 知识库、个人知识与 QA

RuntimeState 保存知识库绑定和稳定条目；prepareTurnSubmission 只选择当前账号/项目相关内容，Gateway action 的 remember 是可复用偏好/流程/领域事实，不保存秘密或临时进度。知识内容是资料，不被当成用户当前授权或渠道命令。

## 两种只读知识工具

LlmWikiMcpClientPool 拥有其 MCP 子进程，与原生 Codex 独立核心不同。MCP 协议目录必须包含所需只读工具；status-only CLI 不算可用知识工具。旧 CLI 模式先 trace document_id，再 realpath 验证文档仍在选定根内；以 nofollow/nonblock 打开普通文件，最多 2 MiB，读前后检查大小/mtime，变化时报错不返回混合版本。CLI 执行输出最多 2 MiB；MCP 在拼接换行和解析 JSON 前按字节限制每帧 2 MiB，尚未换行的帧也受限，正常 UTF-8 跨块不损坏。超限退休该 MCP 子进程并拒绝待处理调用，后续独立检索可重新初始化。请求超时与大小限制分别执行。

选择知识库必须符合实际 host/path，不能拿本机路径在远端执行或把另一个项目的引擎默认为当前库。初始化/条目合并保稳定 ID，动态工具只提供约定 read-only 操作，QA 不因知识绑定缺失就换执行端。stdin EPIPE 和工具进程失败退休自身并报告，不能让宿主因 unhandled error 退出。

llm-wiki-mcp-client、llm-wiki-pipe-failure、knowledge、QA 相关测试验证现有协议与绑定边界；动态文件的真实 symlink/大小组合按 KB case 标注，不能借 IDE 的 symlink 测试代替。本模块不会开启 Workshop 学习或夜间升级。

## 管理表单的异步保存

知识库弹窗通过 knowledge-bases.js.saveKnowledgeBase 调用 /api/knowledge-bases 的 POST/PATCH。一次弹窗提交只允许一个等待中的保存；已发出的请求不因关闭弹窗被假定撤销。回执只能影响原弹窗，不能释放新弹窗的提交状态。同一弹窗等待期间若草稿变化，成功回执保留草稿并提示尚未保存；创建成功且账号未变时，把返回 ID 作为下一次 PATCH 的目标，避免重复创建。账号已切换则仍是新账号的创建草稿。失败保留草稿，下一次明确提交才重试。
