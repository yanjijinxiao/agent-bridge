# 旧 host 标识的冷启动恢复

2026-11-08，头头在切换 3d9f3a5 时首次真实冷启动触发 peer/discover preflight 错误。发布脚本自动恢复原制品，Codex 原执行器未重启。

根因位于 AccountManager.threadSubscriptions：离线能力读取的容错仅接受 peer: 前缀，遗漏 Connector 迁移保留的 local 和 remote-ssh-discovered:*。新进程尚未收到设备注册时，这个只读查询错误逃逸到 startAll，导致进程退出。探探使用 peer: 标识，先前的端到端测试没有覆盖该差异。

修复按错误语义判断：明确 not-submitted 的通信读取失败保留原订阅与不可用状态；其他错误仍抛出。没有改变执行器路由、审批权限、输入回执或恢复重发规则。新增三个 host 组合的启动、绑定保留、不可用展示及重连恢复断言。

隔离复现：修改前 peer: 通过，local 与远程旧标识两项失败且栈均指向 threadSubscriptions；修改后 AccountManager 与 Connector 合计 98 项全部通过。完整封存回归和实际重新部署另见上线回执。
