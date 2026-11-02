# Gateway 管理页面与可选模块

http-server 提供账号、会话、绑定、准入、知识、IDE 与 Taskboard 集成 API；src/web 静态页面只投影后端事实。后端保存成功、UI 当前编辑草稿和某次请求 pending 是三个状态。可选 Taskboard 读取失败只局部报错，不能阻止账号/会话首屏刷新。

## 异步归属和表单

读取及写入捕获账号/项目/会话和请求代次；旧响应只能确认原目标，不能覆盖新选择或 A→B→A 后的新草稿。二维码关闭/重新创建退休旧 poll。原生 form 的 submitter 可能为空，不能把 Enter 当成另一个按钮；复制控件只复制，状态/参考值不用复制框。

绑定页面展示准确 account/chat/host/thread，历史关联与当前边分开。新建会话的候选来源不能从个人准入捏造群 ID。管理界面不把某个项目的 host 默认模型误当其他 host 的实际配置；不确定目录必须显示失败或未知。

knowledge-bases.js 自动刷新在 focused/saving 控件上保留当前输入。Web 上传使用每操作私有目录 0700、文件 0600，服务响应和历史引用保留原操作归属。发布网页与根进程构建分别核验，旧静态缓存不能冒充新版。

architecture-web-state、full-review-web-races、web-native-form-submit、web-bindings、ide-web 与 account-manager 用例给出精确范围。VM 场景证明数据与事件规则，不冒充完整 375px 手机验收；实际设备缺口在审查结论保留。
