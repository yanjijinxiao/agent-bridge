# 探探使用指南：连接 Herdr TUI 或 Herdr App

这篇教程帮助你把自己设备上的 Herdr 接入探探，在钉钉选择终端、发送需求、查看进度和使用项目 Web IDE。你无需部署 Gateway，也无需提供机器人密钥。

Herdr TUI 在终端中使用，适合没有桌面的服务器；Herdr App 是桌面应用。两者都按下面的“准备 → 配置 → 配对 → 选择 → 使用”流程接入，配置部分分别说明。

**本教程连接的是 Herdr 正在管理的终端。** 如果希望直接使用 Codex 的完整历史会话、原生审批和消息队列，请使用 [Codex 接入教程](tantan-connector-guide.md)。即使 Herdr 里运行的是 Codex，经 Herdr 接入时也仍按终端方式工作。

## 1. 可以用探探做什么

| 你想做的事 | 使用方式 |
| --- | --- |
| 继续 Herdr 中已有的工作 | 配对设备，用 /sessions 选择终端，然后发需求 |
| 开始一项新工作 | 指定 agent、终端名称和工作目录，新建终端 |
| 查看当前进展 | 看 AI 卡，或用 /status、/history 查询 |
| 把多条需求和附件一起提交 | 用 /prompt 收集，再一次提交 |
| 查看和修改项目文件 | 开通 Web IDE，使用编辑器、Git 和终端 |
| 在多个设备之间切换 | 先 /connect 选设备，再 /sessions 选终端 |
| 邀请别人使用自己的终端 | 登记所有权、发邀请，由自己审批访问 |

**建议第一次使用先私聊探探。** 同群共用当前绑定；独立做事可分别私聊，或使用不同专用群。

Herdr 接入时，/model、/effort、/plan、/steer、/queue 不会变成底层 agent 的对应操作。模型、工具审批和等待回答的问题，在原 agent 终端中处理；具体方法随 agent 而异。

## 2. 准备并安装 Connector

### 探探 Gateway 的连接地址

Connector 入口：wss://11.158.199.29:49186/gateway/v1/peer

后面的配置模板已经填好这个地址。设备需能访问该内网；浏览器 IDE 使用 /ide 返回的项目链接，不能用这个 WSS 地址打开网页。

### 准备自己的设备

- 安装并打开 Herdr TUI 或 Herdr App，在其中确认自己的 agent 可以正常工作。
- 完成 agent 自己的登录及模型配置。Connector 不代替 Codex、Claude Code 等程序的安装和登录。
- 安装 Node.js 和 npm；Node.js 需满足 Agent Bridge 的运行要求。Git 用于源码安装和项目版本控制。
- 用运行 Herdr 的同一系统账户启动 Connector，首次启动保留交互式终端，以便确认配对。

尚未安装 Herdr 时，从 [Herdr TUI 官方安装页](https://github.com/herdrdev/herdr#install) 或 [Herdr App 官方安装页](https://github.com/herdrdev/herdr-app#install) 按自己的系统安装。已有可用环境可以直接继续，不必为了接入探探重新安装。

### 取得支持 Herdr 的 Connector

在运行 Herdr 的设备上安装 npm 发行包，内含 Gateway 和 Connector。接入探探时只需启动 Connector，不需要另开 Gateway：

```sh
npm install -g @yanjijinxiao/agent-bridge
```

升级已有安装也使用这条命令。安装后重启自己的 Connector 才会加载新程序；安装不会重启 Herdr 或正在执行的 agent。

需要从源码构建时，在设备终端依次执行以下命令。已通过 npm 安装的用户跳过这组命令；已经有仓库的用户进入自己的仓库即可，不重复克隆。

```sh
git clone https://github.com/yanjijinxiao/agent-bridge.git
```

```sh
cd agent-bridge
```

```sh
npm ci
```

```sh
npm run build:bridge
```

第 3 节分别给出 npm 安装和源码构建的启动命令，按自己的安装方式选择一个即可。

### 确认个人准入

探探面向 MaxCompute 部门及其下属部门开放。管理员按正式通讯录维护个人准入；已开通的人不需要再申请。收到“尚未准入”时，联系管理员核对自己的账号。

设备首次连接会自行生成身份。你不需要领取 device.token、填写钉钉用户 ID 或机器人密钥；本文探探入口已内置公开 CA，也不需要填写 caFile。配对时仍需在设备确认具体申请人。

### 选择 TUI 或 App，准备连接信息

**使用 Herdr TUI：** 先在自己的终端中查看 session 列表：

```sh
herdr session list --json
```

找到你正在使用的那一项，核对 name、running 和 socket_path；把该项的完整 socket_path 填入配置的 runtime.socketPath。默认 session 和命名 session 是不同入口，不能因为默认项在线就选它。

需要进入某个命名 session 时，使用下面的模板，先替换名称：

```sh
herdr --session <你的session名称>
```

如果尚未使用命名 session，直接打开 herdr 后，再查询列表取得默认项的路径。这里的 session 是 Herdr 整套工作区的入口，不是单个 agent 的聊天 ID。[官方 CLI 说明](https://herdr.dev/tui/docs/cli-reference/)

**使用 Herdr App：** 打开 App，在本机空间中准备一个普通 shell 终端，再按附录的方法取得窗口 socket、core socket 和 core ID。它们必须属于这个 App；不用另行启动一套 core。

在运行 App 的同一账户环境中检查窗口可访问：

```sh
herdr-app ls
```

结果应能对应 App 里看到的空间、标签页和终端。若命令找不到，先按 Herdr 安装提示把其命令目录加入 PATH。[官方 App 命令说明](https://github.com/herdrdev/herdr-app#for-agents)

### 保存自己的配置

创建配置目录：

```sh
mkdir -p "$HOME/.config/tantan-herdr"
```

从文末选用 **TUI 或 App 其中一份完整模板**，替换注明的设备值，保存为该目录内的 peer-client.json。两个环境同时接入时，分别使用不同配置目录、stateDir 和设备名称。

JSON 中不要写 ~ 或 $HOME，它们不会自动展开。socket 填实际绝对路径；stateDir 可以保留 ./state，按配置文件所在目录解析。

## 3. 启动设备连接，完成第一次配对

通过 npm 或管理员提供的发行包安装时，在设备的交互式终端执行：

```sh
agent-bridge-connector --config "$HOME/.config/tantan-herdr/peer-client.json"
```

如果按第 2 节从源码构建，在 agent-bridge 仓库目录执行：

```sh
npm run peer -- --config "$HOME/.config/tantan-herdr/peer-client.json"
```

**两种启动方式选一种，不同时运行。** 正常启动会检查所选 Herdr 接口，然后连接探探，显示设备名称和完整配对命令。

1. 保持 Connector 终端运行，把它显示的完整 /connect 命令发给探探。
2. 私聊直接发送；群聊从成员列表真正 @探探后发送。
3. 回到设备终端，核对申请人、机器人、聊天及开放范围。
4. 确认是自己的申请后，在设备终端回答：

```text
yes
```

5. 探探确认配对成功后，从返回的目录选择一个终端。

配对码 5 分钟有效，使用后失效。过期时使用新显示的命令；不需要 curl 获取。配对限定具体用户、机器人和聊天，换群或换私聊需要在新的聊天完成配对。

Connector 要保持运行。关闭其终端或按 Ctrl-C 会停止这个前台连接；需要长期运行时，由设备管理员配置系统服务。非交互式启动不会自动批准首次配对。

## 4. 选择设备、项目与终端

### 选择已有终端

在钉钉查看本人在当前聊天可用的设备：

```text
/connect
```

点击自己 Herdr 设备的切换按钮，再查看它的目录：

```text
/sessions
```

目录按项目和终端组织，空项目也保留。TUI 显示所选 session 中的工作区及终端；App 显示所连接窗口、同一 core 中的资源。先核对名称、机器和工作目录，再点选择。

绑定后检查：

```text
/status
```

确认是预期设备和终端后再发需求。只从 /connect 换了设备，还没有换绑时，普通消息仍发往原绑定终端；要完成换绑，还需从 /sessions 选中目标。

### 为什么看不到 agent 的所有历史会话

/sessions 这里列的是 Herdr 正在管理的终端，不扫描 agent 磁盘上的全部聊天历史。若要继续某段旧对话，先在目标 Herdr 终端内按该 agent 的 resume 方法打开，再到探探选择这个终端。

TUI 的其他 session 不会混入当前列表。App 远端资源跟随该 App 已连接的机器；某台机器离线时先恢复它的连接，不能把缺失条目当作已删除。

### 在项目中新建终端

可以先查看并选择项目：

```text
/project
```

然后使用下面的 **命令模板**。把 agent、名称和目录替换为自己的实际值；目录必须已存在，含空格时保留双引号。

```text
/new --agent <程序名> --name <终端名称> --cwd "<项目绝对目录>"
```

例如程序名可用已安装且可运行的 codex；TUI 还要求它是 Herdr 已识别的 agent。TUI 名称以小写字母开头，长度 1–32，使用字母、数字、下划线或短横线。App 使用明确的程序名。

已选中同一设备的项目时，可省略 --cwd，使用项目目录。切换设备后不要沿用上一台设备的目录。需要程序参数时，在命令末尾使用 --，后面的内容作为程序参数传递，不按 shell 展开。

**Herdr 的 /new 会实际启动程序。** 它与 Codex 接口中仅创建会话上下文不同。若提示已经创建面板、后续启动失败，先到 Herdr 核对该面板，不要连续重发创建命令。

### 改名称

绑定目标终端后，使用模板：

```text
/session rename <新名称>
```

App 只允许重命名独占一个终端的标签页；多终端标签页请回到 App 调整，避免连带改动其他人的显示。

## 5. 发送需求、附件与后续任务

### 发送第一条需求

终端就绪后，直接发自然语言，例如：请阅读这个项目的 README，说明启动步骤，先不要修改文件。

探探把需求交给当前终端中的 agent，并持续观察结果。需要登录、首次确认或正在等待回答时，先在 Herdr 中处理，让 agent 回到可以接收新需求的状态。

### 命令和帮助怎么用

/help 展示当前 Herdr 入口的完整命令说明；/help session 查看绑定、新建、跟随和关闭终端，/help input 查看合并消息、进度与回执，/help access 查看权限和共享，/help workflow 查看项目和看板，/help capabilities 查看原生能力限制。也可以用 /help stop 等查看单个命令。

已注册的 Gateway 命令优先处理，包括它们的别名和已安装扩展。未注册的 /xxx 会先收到一条简短文字提示，再作为普通消息原样交给当前终端；路径、引文和正文中出现的斜杠直接作为普通内容。能否提交仍取决于权限、绑定和终端状态。

因此，Gateway 已注册的 /model、/plan 等即使在 Herdr 上不支持，也会明确说明，不会转交 agent。需要使用与 Gateway 同名的 agent 命令时，在原 Herdr 终端操作。参数错误也不会触发转发。

### 运行中能否继续插话或排队

Herdr 没有与 Codex 原生 steer、queue 等价的接口。终端正忙、等待人工输入或状态不明时，探探不会把新消息直接敲进去，也不会自动创建另一条任务队列。

此时先看实际回执。明确显示未提交的消息，等终端就绪后再处理；显示提交结果不明的消息，先通过 /inbox 和 Herdr 画面核对，不能直接重发。

```text
/inbox
```

### 发送图片和文件

像普通钉钉消息一样附上图片或文件，并写清用途。探探将附件放到绑定终端所在机器，再把附件位置和需求交给 agent；能否理解图片等内容取决于该 agent 本身。

附件转存需要能够确认终端的工作目录和机器。只有文字输入可用，不代表文件传输已经可用；转存失败时先处理连接或目录问题，查看 /inbox 确认这条消息是否提交。

需要取回 agent 生成的文件，可在项目 Web IDE 的文件列表中下载。终端里出现一个文件路径或发送指令样例，不会自动变成钉钉附件发送操作。

### 合并多条需求和附件

开始收集：

```text
/prompt start
```

连续发送要合并的文字及附件，准备好且终端就绪后提交：

```text
/prompt done
```

放弃尚未提交的收集内容：

```text
/prompt cancel
```

/prompt 只是合并一次输入，不是运行中的队列。取消收集不会停止已提交的工作；多人群聊不要交叉使用同一个收集区。

## 6. 进度、审批与任务控制

### 如何看进度

Herdr 的 AI 卡是一个终端窗口：同一张卡持续显示最新终端文字，包括正文、命令和输出；尽量利用卡片容量，超出后覆盖最早的文字。不再区分或累积阶段成果，也不因为内容变长新建卡片。状态、可用的停止控件和项目 Web IDE 入口仍保留；结束时在原卡保留最新窗口并移除停止控件。

TUI 读取最近 512 行终端内容，App 使用当前画面。因此，窗口中仍可见的旧问答也可能出现在当前卡片里；卡片不是“只显示最后一轮”的答复，也不是完整日志归档。Herdr 有状态和轮次相关计数，但当前正文接口不能按某个 turn 精确提取输出，探探不通过文本差分假装实现这个保证。

卡片不能补回底层接口没有返回的历史。要另外查询终端当前可读取的内容，可以发送：

```text
/history
```

/history 是终端文本快照，不是结构化聊天历史。模型、工具审批等仍在原 Herdr 终端中处理。

| 看到的状态或提示 | 应该怎么做 |
| --- | --- |
| 正在工作 | 等待结果；需要中断时使用 /stop |
| 等待人工处理 / blocked | 去原 Herdr 终端处理问题或审批 |
| 空闲 / done | 阅读实际输出确认结果；空闲不等于任务成功 |
| 状态不明 / 执行状态待确认 | 用 /status、/history、/inbox 核对，不重复提交 |
| 终端退出或不可用 | 回 Herdr 检查进程，必要时选择或创建新的终端 |

只想同步观察已有工作时，可使用 /follow on 开启跟随、/follow off 关闭、/follow sync 同步一次。它们不发送任务。/stream 控制进度显示，不改变终端执行状态。

### 在哪里处理审批和修改模型

**Herdr 中的工具审批在原 agent 终端处理。** 探探能显示它正在等你，但不会把聊天里的“同意”或 /approve 自动变成终端按键。终端中的审批文字也不会被包装成可点击的原生审批卡。

模型、推理强度及计划模式同样使用 agent 自己的界面或命令。/model、/effort、/plan、/goal、/balance 通过 Herdr 不提供相应原生功能；/help 会说明当前入口的支持范围。

设备配对和共享访问审批仍在第 3、8 节所述位置处理，它们与 agent 的工具审批是不同事项。

### 停止当前工作

确实要中断当前工作时发送：

```text
/stop
```

App 调用原生中断接口。TUI 需要预先为对应 agent 配置一个中断键；附录的 Codex 示例使用 Esc，不会把这个键套用给所有 agent。

“已请求中断”表示请求已发出，仍需观察后续状态。它不表示程序已退出，也不能作为任务成功的证明。终端正在等审批时，探探不会尝试一串按键。

### 解绑与关闭终端

只解除当前聊天绑定：

```text
/unbind
```

这不会停止原终端、删除项目或撤销设备配对。

如果你确定要结束所绑定的终端进程，才发送：

```text
/session close --confirm
```

App 会结束指定终端，TUI 会关闭对应面板；这会影响其中正在运行的程序。关闭终端与关闭一张钉钉卡片不是同一件事。

## 7. 用 Web IDE 查看、编辑项目

### 开通一次

设备端在原 peer-client.json 中设置下列值，保留其他字段，再重启 Connector：

| 配置项 | 设置值 |
| --- | --- |
| webIDE.enabled | true |
| webIDE.binary | code-server |
| webIDE.autoInstall | true |

探探管理员还需启用设备 IDE 并配置浏览器入口。首次打开时，Connector 检查、下载并安装支持的 code-server 制品，无需另行手动安装；设备需要下载网络和受支持的系统。已有安装也可使用真实 binary 路径，并关闭 autoInstall。

### 打开项目

绑定具有明确项目和工作目录的终端后发送：

```text
/ide
```

点返回的项目链接进入，使用文件编辑、Git 和集成终端。进行中的卡片及最终回复也会显示已有项目入口。没有可信工作目录的终端仍可查看或发文字，但不能据此开放 IDE 或文件访问。

同一项目使用固定链接。访问方式由管理员配置：可以是首次确认浏览器后进入，也可以是已授权项目持链接直达；不要求再设置一套 IDE 密码。个人浏览器授权最长 90 天，撤销或到期后重新确认。直达链接应只分享给允许使用该项目的人。

### 设置和扩展

主题、字体、字号从编辑器设置调整，GitLens 等扩展从扩展面板安装。扩展按当前 IDE 项目保存，桌面 VS Code 已安装不代表这里也已安装。

需要复用已有设置，可由管理员导入 settings.json / JSONC、.vscode/extensions.json 或 .code-profile 中支持的设置和扩展；保存后应用，不要在这些文件里放令牌和密码。

### 远端机器需要什么

Herdr App 的远端终端使用实际远端目录，IDE 和文件也在该机器上操作。远端需要可运行 Node，并且 Connector 能通过已配置的非交互 SSH 或该机器的 via 命令连接。

“App 能连上远端终端”不一定表示外部文件连接已准备好。如果只有 App 内部的密码会话可用，先配置 SSH 密钥、主机密钥等连接条件；不要把远端目录改成本机同名目录来绕过错误。

仅获共享文本权限的访客使用共享 Web 编辑器，不包含完整 IDE 的 Git 和终端。完整 IDE 终端具有设备运行账户的权限，项目列表本身不是操作系统沙箱。

## 8. 共享终端与多人群聊

### 谁提供终端，谁批准访问

先绑定自己的终端，登记所有权：

```text
/share claim
```

回到 Connector 终端核对身份和目标并确认。首次绑定并不自动登记所有者；登记后，其他人不能仅凭普通设备配对直接使用这个私人资源。

生成邀请：

```text
/share invite
```

把返回的完整 /join 命令发给访问者。对方在目标私聊或群里发送，提交申请；邀请码不直接授予权限。

所有者在仍选中该终端的聊天中查询：

```text
/share requests
```

核对后使用模板批准，把占位符换成真实申请 ID：

```text
/share approve <申请ID>
```

访问者重新发送原 /join 命令，完成绑定。授权限定用户、聊天和指定资源，默认 24 小时；所有者可用 --hours 指定 1–168 小时，用 /share list 查询、/share deny 拒绝申请、/share revoke 撤销授权。

需要共享文本目录时，所有者用 /share claim --ide 在设备确认目录，再在批准命令中明确选择 --ide read 或 --ide write。文件权限通过 --files 另行授予。会话访问、文本编辑和完整 IDE 不是同一权限。

### 同群怎么协作

一个群共用当前绑定。符合准入及设备权限的成员可以换绑到自己的终端，后续群消息会发往新目标；原终端的任务不会因此停止。需要各自独立操作时，分别私聊探探或各建专用群。

停止任务等控制操作还受聊天角色限制，可用 /role 查看。机器人管理员或聊天 controller 不会自动成为别人资源的所有者。群里已经发出的结果和附件对群成员可见。

## 9. 常见问题与恢复

| 现象 | 先检查什么 |
| --- | --- |
| 启动提示未知 backend 或 runtime | 使用的 Connector 是否包含 Herdr 适配；全局命令和源码构建可能不是同一份程序 |
| socket 不存在或连接失败 | Herdr 是否运行、是否同一系统用户、路径是否绝对路径；TUI 是否选错 session |
| App 窗口不可达 | App 是否打开，windowSocketPath 是否属于当前 App；core 在线不能代替窗口在线 |
| core 身份不一致 | 按附录从当前 App 的本机终端重新核对 socket 和 core ID，不用 PID 或版本号代替 |
| 报接口版本不兼容 | 把 Herdr 和 Connector 版本及错误交给管理员核对，不通过改配置字段伪装兼容 |
| /connect 看不到设备 | Connector 是否在线、本人是否在当前机器人和聊天完成配对 |
| /sessions 缺少某段历史聊天 | 先在所选 Herdr 终端恢复该 agent 的旧对话；目录不扫描全部磁盘历史 |
| 普通消息提示终端未就绪 | 在 Herdr 处理登录、审批或正在等待的输入，确认状态后继续 |
| /stop 提示未配置 | TUI 需为对应 agent 配置一个明确中断键；也可以回原终端手动中断 |
| 卡片空闲但工作未达到预期 | 阅读实际输出，检查 agent 是否只是等输入；空闲不是业务验收 |
| 附件失败但文字可以发送 | 核对工作目录、目标机器和文件连接条件；先查看原输入回执 |
| /ide 没入口或被拒绝 | 核对项目归属、设备端 webIDE、探探侧开通和本人权限 |
| App 里远端可用，IDE 连接失败 | 核对远端 Node、非交互 SSH 或 via 连接 |
| stateDir 被占用 | 确认是否有另一个 Connector 使用同一目录；不要直接删锁或复制别人状态 |

### 断线和重启

单独重启 Gateway 后会重连原 Connector、同步原资源。已经写入终端或结果不明的输入不会自动重发。Gateway 等待结果，不会因此拥有或停止 Herdr 的任务。

Connector 断线时先恢复连接，用 /status、/history 和 /inbox 核对。App 窗口关闭后，其 core 中的程序可以继续，但探探的 App 目录和控制需要窗口入口恢复。TUI 客户端退出与其后台服务停止也不同。

Herdr 执行服务本身退出或机器关机，会影响其中的程序。重新出现布局或新 shell，不代表原任务仍在运行。[Herdr 恢复说明](https://herdr.dev/tui/docs/session-state/)

如果项目入口停在“正在打开 Web IDE”并显示连接失败，先核对页面提示：连接超时可检查网络后重试；请求过期请点击“重新打开”取得新的入口请求。升级后重新点原项目链接即可，不需要更换固定链接或重新配对设备。管理员排查时应核对浏览器入口脚本与后端请求日志，不能仅凭设备在线判定页面可用。

### 更新自己的 Connector

先准备好新的程序和依赖，再停止旧 Connector，用原配置启动。保留配置、stateDir、设备身份及 Herdr 数据，不删除授权或回执来“恢复连接”。不需要重建原有终端。

同一 stateDir 同时只运行一个 Connector。容器部署的状态目录应由固定实例管理，并使用稳定的主机进程视图；每次都以隔离 PID 1 重建的容器可能无法判断旧锁，交由设备管理员处理。更新前保存浏览器未保存的文件，IDE 连接可能短暂断开。

反馈问题时提供设备名称、时间和报错即可，不发设备凭据、完整配置中的秘密或不相关会话内容。

## 10. 管理员交付时需要准备什么

1. 核对用户个人准入及探探内网可达性，交付支持 Herdr 的 Connector 程序。
2. 与用户确认使用 TUI 还是 App，取得实际连接信息，预填下方对应模板；保留固定探探地址。
3. 在用户交互式终端启动，完成一次具体用户和聊天的配对，不分发设备 token。
4. 核对 /sessions、/status 中的机器及目录，做一次普通需求往返，确认输出属于原终端。
5. 需要 IDE 时，同时开通两侧配置，并实际打开项目检查编辑、Git 和终端。
6. 说明工具审批在哪里处理、忙时输入的限制，以及共享访问由所有者批准。

兼容版本、发布记录和验收证据供管理员在 [Herdr 适配记录](audits/2026-11-07-herdr-adapters/README.md) 核对，日常使用按本教程操作即可。

## 附录：填写 peer-client.json

### 哪些值要修改

| 字段 | 你需要做什么 |
| --- | --- |
| url | 保留模板中的探探 WSS 地址 |
| label | 改为自己能识别的设备名称，可用中文 |
| profileId | 保留 default；不是 agent 模型配置名 |
| backend | 按实际选 herdr-tui 或 herdr-app，与 runtime.kind 一致 |
| runtime.version | 保留数字 1，它是配置格式版本 |
| runtime.id | 自定稳定名称；1–80 位英文字母、数字、下划线或短横线 |
| runtime.socketPath | TUI 专用；从 herdr session list --json 的目标项取得 |
| runtime.windowSocketPath | App 专用；当前 App 的窗口 socket，方法见下文 |
| runtime.coreSocketPath | App 专用；从当前 App 本机 shell 的 HC_TERMINAL_SOCKET 取得 |
| runtime.expectedCoreId | App 专用；从该 socket 返回的 core.id 取得，不能自行编造 |
| runtime.interruptKeys | TUI 可选；按准确 agent 名配置一个 esc 或 ctrl+c，不写通配符 |
| stateDir | 可保留 ./state；每个 Connector 独立使用且长期保留 |
| webIDE | 初次可以关闭，按第 7 节开通时修改 |

Herdr 配置不填写 codexHome、codexBin、appServerTransport 或 managedHosts。新设备省略 nodeId/tokenFile；已有旧配置需成对保留二者。不要把别人的设备凭据、socket 或 core ID 拷进自己的配置。

### TUI 完整配置模板

**需要编辑：** label 和 socketPath。下面 socketPath 是示例，必须替换为第 2 节查询到的实际绝对路径。interruptKeys 只示范 Codex 的 Esc；不使用 Codex 可删除这一项，其他 agent 按实际停止键配置。

```json
{
  "url": "wss://11.158.199.29:49186/gateway/v1/peer",
  "label": "我的 Herdr TUI",
  "profileId": "default",
  "backend": "herdr-tui",
  "runtime": {
    "version": 1,
    "id": "my-herdr-tui",
    "kind": "herdr-tui",
    "socketPath": "/home/你的用户名/.config/herdr/sessions/你的session/herdr.sock",
    "interruptKeys": { "codex": "esc" }
  },
  "stateDir": "./state",
  "webIDE": { "enabled": false, "binary": "code-server", "autoInstall": false }
}
```

### App 的三个连接值从哪里取得

**窗口 socket：** 默认是自己的 ~/.config/herdr-app/herdr-app.sock，填入 JSON 时展开为完整绝对路径。自定义过 HERDR_APP_HOME 时使用该目录；否则自定义过 XDG_CONFIG_HOME 时使用其中的 herdr-app 目录。以启动 App 的实际环境为准。

**core socket 与 ID：** 在 Herdr App 的本机空间内打开一个普通 shell 终端，执行下面这条完整查询命令。不要在远端空间执行，也不要把命令发给正在处理任务的 agent。

它只连接当前终端所属的既有 core，查询身份后退出，不启动另一个服务。终端没有提供 socket 时会报错停止；不要随意挑选机器上的其他 socket。

```sh
node --input-type=module <<'NODE'
import net from 'node:net';
const socketPath = process.env.HC_TERMINAL_SOCKET;
if (!socketPath) throw new Error('请在 Herdr App 的本机普通 shell 终端执行');
const socket = net.createConnection(socketPath);
let buffer = '';
let received = false;
const timer = setTimeout(() => socket.destroy(new Error('查询超时')), 5000);
socket.once('connect', () => socket.write(JSON.stringify({
  jsonrpc: '2.0', id: 'tutorial-identity', method: 'hello',
  params: { generation: 1, framed: false }
}) + '\n'));
socket.on('data', chunk => {
  buffer += chunk.toString();
  if (buffer.length > 1024 * 1024) return socket.destroy(new Error('响应过大'));
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    let reply;
    try { reply = JSON.parse(line); }
    catch { return socket.destroy(new Error('响应格式错误')); }
    if (reply.id !== 'tutorial-identity') continue;
    if (reply.error || !reply.result?.core?.id) {
      return socket.destroy(new Error('未取得 core ID，请核对 App 接口'));
    }
    received = true;
    console.log(JSON.stringify({
      coreSocketPath: socketPath, expectedCoreId: reply.result.core.id
    }, null, 2));
    socket.destroy(); return;
  }
});
socket.once('error', error => { console.error(error.message); process.exitCode = 1; });
socket.once('close', () => {
  clearTimeout(timer);
  if (!received && !process.exitCode) {
    console.error('连接已关闭，未取得 core ID'); process.exitCode = 1;
  }
});
NODE
```

把输出的两个值填回下方 JSON 的同名字段。core ID 是服务标识，不是设备凭据；不需要发送到群里。窗口和 core 必须对应，启动后再用 /sessions 对照 App 中的资源确认。

### App 完整配置模板

**需要编辑：** label、windowSocketPath、coreSocketPath 和 expectedCoreId。所有“替换为……”都是占位内容，不能原样启动。

```json
{
  "url": "wss://11.158.199.29:49186/gateway/v1/peer",
  "label": "我的 Herdr App",
  "profileId": "default",
  "backend": "herdr-app",
  "runtime": {
    "version": 1,
    "id": "my-herdr-app",
    "kind": "herdr-app",
    "windowSocketPath": "/Users/你的用户名/.config/herdr-app/herdr-app.sock",
    "coreSocketPath": "/替换为实际core的socket绝对路径",
    "expectedCoreId": "替换为实际core.id"
  },
  "stateDir": "./state",
  "webIDE": { "enabled": false, "binary": "code-server", "autoInstall": false }
}
```

保存为 UTF-8 普通文本，保留英文双引号，不带 Markdown 代码框标记，不添加 JSON 注释或多余尾逗号。

### 启动前核对

1. Herdr 及目标 agent 可用，Connector 程序支持所选接口。
2. 探探 URL 保留完整路径，当前账号已有准入。
3. 已替换全部占位值；socket 属于自己的目标服务，不是猜测路径。
4. backend 与 runtime.kind 一致，配置没有混入 Codex 专有字段。
5. stateDir 独立、持久，没有另一个 Connector 同时写入。

完成后回到第 3 节启动并配对。
