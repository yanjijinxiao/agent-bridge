# Gateway 管理页面与可选模块

http-server 提供账号、会话、绑定、准入、知识、IDE 与 Taskboard 集成 API；src/web 静态页面只投影后端事实。后端保存成功、UI 当前编辑草稿和某次请求 pending 是三个状态。可选 Taskboard 读取失败只局部报错，不能阻止账号/会话首屏刷新。

## 异步归属和表单

读取及写入捕获账号/项目/会话和请求代次；旧响应只能确认原目标，不能覆盖新选择或 A→B→A 后的新草稿。二维码关闭/重新创建退休旧 poll。原生 form 的 submitter 可能为空，不能把 Enter 当成另一个按钮；复制控件只复制，状态/参考值不用复制框。

绑定页面展示准确 account/chat/host/thread，历史关联与当前边分开。新建会话的候选来源不能从个人准入捏造群 ID。管理界面不把某个项目的 host 默认模型误当其他 host 的实际配置；不确定目录必须显示失败或未知。

knowledge-bases.js 自动刷新在 focused/saving 控件上保留当前输入。Web 上传使用每操作私有目录 0700、文件 0600，服务响应和历史引用保留原操作归属。发布网页与根进程构建分别核验，旧静态缓存不能冒充新版。

architecture-web-state、full-review-web-races、web-native-form-submit、web-bindings、ide-web 与 account-manager 用例给出精确范围。VM 场景证明数据与事件规则，不冒充完整 375px 手机验收；实际设备缺口在审查结论保留。

## 旧页面与同进程启用的浏览器路径

WEB-01.3用生产HTML/JS、真实本机HTTP服务关闭并在原端口重开，旧DOM通过request-context握手后仅实际改名一次；服务已提交后模拟浏览器丢响应，不重发。WEB-02.2点击原生启用按钮经/api/taskboard/start、TaskboardLifecycle启动真实嵌入服务，Gateway PID不变；禁用时iframe无src。WEB-02.3在375px真实隔离Chrome逐管理视图、长ID/标题、IDE按钮及全部含form的dialog量测边界，不能写成手机实机通过。

通知设置和新建会话遵守相同身份边界：个人准入不等于群会话；缺少明确接收路线时留空让用户选择，不捏造群ID。控件的hidden状态高于grid/flex布局，避免为不适用的渠道或模式显示可操作选项。WEB-01.8验证四渠道目标，WEB-02.4用生产页面及CSS核对隐藏/重新显示。

管理页设置保存只确认点击保存时的快照。等待期间新增的字段编辑属于未提交草稿，成功回执不能通过 renderAll 覆盖它；模型和推理强度选项重建也须保留后续选择。保存失败保持草稿，同一保存等待期间的重复表单提交不再发第二次 PUT。此边界不改变后端权限政策，也不自动重发未知写入。
