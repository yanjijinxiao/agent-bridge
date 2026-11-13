import type { CodexBackendCapabilities } from "../codex/backend.js";
import type { ChannelChoice } from "../channels/action-card.js";
export const HELP_SECTIONS = {
  session: "设备、会话与跟随", input: "输入、进度与恢复", access: "准入、共享与 IDE",
  workflow: "项目与工作流", capabilities: "模型与原生能力"
} as const;
export type HelpSection = keyof typeof HELP_SECTIONS;
type HelpVariant = {
  usage?: string;
  description: string;
  summary?: string;
  details?: readonly string[];
};
export type ChannelCommandDefinition = {
  name: string;
  aliases: readonly string[];
  capability?: keyof CodexBackendCapabilities;
  /** Record controls must remain discoverable after switching to another backend. */
  record?: boolean;
  /** Read/disable/reset branches do not require a native observer. */
  localControl?: boolean;
  compatibility?: boolean;
  help: HelpVariant & {
    section: HelpSection;
    terminal?: HelpVariant;
    navigation?: {
      label: string;
      command: ChannelChoice["command"];
      arg: string;
    };
  };
};
/** Names, aliases, help, presentation levels and native capability hints have
 * one owner. This is descriptive data, never an authorization or RPC dispatcher.
 * Omitting a summary puts a command in detailed help, not on the home page. */
export const CHANNEL_COMMAND_REGISTRY = [
  {
    "name": "help",
    "aliases": [
      "h"
    ],
    "help": {
      "section": "session",
      "usage": "[all|session|input|access|workflow|capabilities|命令名]",
      "summary": "查看常用、分项或完整帮助。",
      "description": "无参数查看常用入口；all 查看完整参考。分项与单命令帮助在所有后端使用相同语法；/help /session 查看单个绑定命令。"
    }
  },
  {
    "name": "connect",
    "aliases": [],
    "help": {
      "section": "session",
      "usage": "[配对码|use C编号]",
      "summary": "连接设备或选择目录来源。",
      "description": "查看本人在当前聊天已授权的 Connector。配对需设备端确认；use 只切换目录来源，不改变已绑定会话。",
      "details": [
        "/connect use local 仅选择管理员已配置且本人有权访问的逻辑本机 Connector。"
      ],
      "navigation": {
        "label": "设备",
        "command": "connect",
        "arg": ""
      }
    }
  },
  {
    "name": "project",
    "aliases": [
      "projects",
      "p"
    ],
    "help": {
      "section": "workflow",
      "usage": "[l|P编号|C编号]",
      "summary": "查看或选择项目，不换绑已有会话。",
      "description": "选择新建会话及工作流的项目上下文；使用 /new 或 /session 绑定会话。",
      "details": [
        "/project detail P编号 查看主机、目录及项目身份，不切换项目。",
        "/project rename P编号|新名称 只改 Gateway 显示名称。",
        "/project delete P编号 只移除无任务的 Gateway 登记；不删除原生项目或目录，刷新仍可能发现。",
        "兼容写法：/project add（/p a）等同项目选择；rename/delete 也接受 rn/d。"
      ],
      "navigation": {
        "label": "项目",
        "command": "project",
        "arg": "list"
      }
    }
  },
  {
    "name": "sessions",
    "aliases": [
      "ss"
    ],
    "help": {
      "section": "session",
      "usage": "[all|more|prev|page 页码|size 5-50|search 关键词|detail R编号|unbound|project]",
      "summary": "查看所选设备的项目与会话。",
      "description": "置顶 → 项目及其会话 → 其他会话；保留空项目，默认每页 50 项。查询不改变绑定。",
      "details": [
        "/sessions size 50 保存每页项数；/sessions more 或 /sessions prev 翻页。",
        "/sessions detail R编号 查看完整标题、主机、目录和 ID，不切换会话。",
        "/sessions all 查看全部已授权来源；/sessions --host 主机ID 临时筛选，不改变所选设备。",
        "/sessions search 关键词 搜索标题、目录或会话 ID；unbound/project 分别筛选无项目或当前项目会话。"
      ],
      "terminal": {
        "description": "查看所选 Connector 的终端目录，按项目组织并保留空项目；终端资源不等于 agent 历史会话。"
      },
      "navigation": {
        "label": "会话",
        "command": "sessions",
        "arg": ""
      }
    }
  },
  {
    "name": "session",
    "aliases": [
      "s"
    ],
    "help": {
      "section": "session",
      "usage": "R编号或会话ID [--host 主机ID]",
      "summary": "选择并绑定会话，自动跟随进展。",
      "description": "使用当前列表的 R编号自动携带主机；手工绑定时，--host 填详情中的主机 ID。绑定会回看历史并跟随原生进展，不启动新任务。",
      "details": [
        "兼容写法：/session new ...（含 /s new）等同 /new ...。"
      ],
      "terminal": {
        "description": "绑定指定终端并跟随画面。查看和绑定不会重新启动终端程序。",
        "details": [
          "/session rename 新名称 修改资源名称（App 要求独占标签页）。",
          "/session close --confirm 会结束指定终端进程；这不是解绑或聊天归档。",
          "兼容写法：/session new ...（含 /s new）等同 /new ...。"
        ]
      }
    }
  },
  {
    "name": "new",
    "aliases": [
      "n"
    ],
    "help": {
      "section": "session",
      "usage": "[P编号|C编号|完整项目名|--project 项目|--standalone]",
      "summary": "在选定项目新建并绑定会话。",
      "description": "在当前或指定项目创建原生空会话，下一条消息才启动任务。没有当前项目时提示选择，不自动选第一个项目。",
      "details": [
        "/new --standalone 在所选设备使用独立持久目录创建无项目会话；/new --project 项目 显式指定项目。"
      ],
      "terminal": {
        "usage": "--agent 程序名 --name 名称 [--cwd 绝对目录] [-- 程序参数]",
        "summary": "按启动配置新建并绑定终端。",
        "description": "使用已配置的 agent 程序新建终端；按目录选择路由，不借用另一设备的目录。程序参数使用 -- 分隔。",
        "details": [
          "省略目录时使用当前项目；TUI 名称需为小写字母开头的 1–32 位字母、数字、_ 或 -。创建会实际启动程序。"
        ]
      }
    }
  },
  {
    "name": "status",
    "aliases": [
      "where",
      "st"
    ],
    "help": {
      "section": "session",
      "summary": "查看当前绑定、任务和运行状态。",
      "description": "查看当前项目、会话、模型、执行及同步状态，不启动任务。",
      "terminal": {
        "description": "查看绑定终端、接口、运行状态与证据。空闲或终端报告结束不代表原生任务验收成功。"
      },
      "navigation": {
        "label": "状态",
        "command": "status",
        "arg": ""
      }
    }
  },
  {
    "name": "history",
    "aliases": [
      "hist"
    ],
    "help": {
      "section": "session",
      "usage": "[1-20|more]",
      "summary": "查看最近对话。",
      "description": "默认查看最近 20 条对话；/history more 继续查看更早内容。",
      "terminal": {
        "usage": "",
        "summary": "查看当前终端画面。",
        "description": "查看当前终端画面和可用滚动内容，不是 Codex 的历史对话翻页。"
      }
    }
  },
  {
    "name": "ide",
    "aliases": [],
    "help": {
      "section": "access",
      "summary": "获取当前项目 Web IDE 入口。",
      "description": "返回当前项目固定入口，不启动 agent 任务。持链接进入的项目直接打开；个人浏览器确认模式按页面操作。",
      "details": [
        "/ide identity 用于诊断个人准入与浏览器配对资格。",
        "/ide auth 六位识别码 是兼容核对流程；trust/access/deny/confirm 使用原授权页提供的完整命令，不手填内部值。",
        "兼容写法：/ide status 等同 /ide。共享编辑器的目录权限仍由会话提供者授予。"
      ],
      "navigation": {
        "label": "Web IDE",
        "command": "ide",
        "arg": ""
      }
    }
  },
  {
    "name": "model",
    "aliases": [
      "m"
    ],
    "capability": "models",
    "help": {
      "section": "capabilities",
      "usage": "[编号|模型ID|default]",
      "summary": "查看或切换当前会话模型。",
      "description": "读取或更新原生会话模型，Gateway 不另存执行覆盖值；default 只刷新原生设置，不是重置。",
      "terminal": {
        "description": "需要运行接口提供结构化模型设置；不会把模型命令盲打进终端。"
      }
    }
  },
  {
    "name": "effort",
    "aliases": [
      "e"
    ],
    "capability": "models",
    "help": {
      "section": "capabilities",
      "usage": "[编号|级别|default]",
      "summary": "查看或切换推理强度。",
      "description": "按当前模型支持范围更新原生推理强度；default 只刷新原生设置，不是重置。",
      "terminal": {
        "description": "需要运行接口提供结构化推理设置。"
      }
    }
  },
  {
    "name": "queue",
    "aliases": [],
    "capability": "nativeQueue",
    "record": true,
    "help": {
      "section": "input",
      "usage": "消息；/queue list；/queue cancel 队列ID",
      "summary": "把消息排到原生队列的下一轮。",
      "description": "新消息进入原生队列，不插入当前轮次。list/cancel 核对本聊天回执、取消自己的待执行项；原记录按原目标处理。",
      "terminal": {
        "description": "提交新消息需要原生队列接口。list/cancel 仍可核对和处理本聊天原队列记录，不因换绑而改变目标。"
      }
    }
  },
  {
    "name": "stop",
    "aliases": [
      "x"
    ],
    "help": {
      "section": "session",
      "summary": "中断当前任务，需要控制者权限。",
      "description": "请求中断当前任务，不删除会话或解绑聊天；需要 controller 权限。",
      "terminal": {
        "description": "依据已配置的接口能力请求终端中断；不关闭整个运行服务，不把发送中断当作任务成功。需要 controller 权限。"
      }
    }
  },
  {
    "name": "unbind",
    "aliases": [],
    "help": {
      "section": "session",
      "summary": "解绑当前聊天，原任务继续运行。",
      "description": "仅解绑当前 IM 对话并停止本对话跟随；不删除会话、不停止任务、不影响其他聊天。普通消息不自动接回旧会话。"
    }
  },
  {
    "name": "leave",
    "aliases": [],
    "compatibility": true,
    "help": {
      "section": "session",
      "description": "/unbind 的兼容命令，行为完全相同。"
    }
  },
  {
    "name": "follow",
    "aliases": [],
    "capability": "liveFollow",
    "localControl": true,
    "help": {
      "section": "session",
      "usage": "[on|off|sync]",
      "description": "查看同步健康。绑定后默认跟随；on 开启并同步，off 停止本聊天跟随，sync 立即同步当前绑定。均不重发输入或停止原任务。",
      "details": [
        "/follow primary 指定新轮次的提问、审批主交互目标；需要 controller 权限，原交互归属不变。",
        "/follow sync --retry-delivery 明确重试原实例未知投递，可能重复通知；仅在相关故障提示下使用。"
      ],
      "terminal": {
        "description": "只读跟随原终端；off 停止本聊天跟随，sync 同步当前画面，不重发终端输入。",
        "details": [
          "primary 不改写 Codex 审批路由；sync --retry-delivery 由控制者明确重试原卡投递，可能重复通知。"
        ]
      }
    }
  },
  {
    "name": "stream",
    "aliases": [
      "str"
    ],
    "capability": "progress",
    "localControl": true,
    "help": {
      "section": "input",
      "usage": "[on|off|default]",
      "description": "控制过程展示，最终结果仍发送；default 恢复继承全局展示设置。与 /follow 的订阅、同步开关独立。",
      "terminal": {
        "description": "控制终端过程展示：在一张 AI 卡内尽量显示最新终端文字，达到容量后滚动覆盖旧内容；不推断阶段或 turn 边界。最终结果仍发送。"
      }
    }
  },
  {
    "name": "prompt",
    "aliases": [
      "pp"
    ],
    "help": {
      "section": "input",
      "usage": "[start|s|done|d|cancel]",
      "description": "start 合并多条文字及附件，done 一次提交，cancel 丢弃尚未提交的合并区；无参数查看状态。不是查看系统提示词。"
    }
  },
  {
    "name": "inbox",
    "aliases": [],
    "record": true,
    "help": {
      "section": "input",
      "description": "查看已保存的待转发消息及原目标，按页面核对、重试或取消。已接收或回执不明的输入不会自动重发。"
    }
  },
  {
    "name": "steer",
    "aliases": [
      "iv"
    ],
    "capability": "turnSteering",
    "help": {
      "section": "input",
      "usage": "补充要求",
      "description": "显式插入当前运行轮次；普通消息默认也使用安全插话。不支持时拒绝，不暗中排队或改投其他执行器。"
    }
  },
  {
    "name": "policy",
    "aliases": [],
    "help": {
      "section": "input",
      "usage": "[ask|steer|queue]",
      "description": "查看或设置运行中消息策略：steer 插入当前轮次（默认），queue 原生排到下一轮，ask 每次询问；设置受当前能力限制。",
      "terminal": {
        "description": "查看消息处理策略。终端忙碌时不使用按键伪装原生插话或队列；不支持的设置明确拒绝。"
      }
    }
  },
  {
    "name": "intervene",
    "aliases": [],
    "record": true,
    "help": {
      "section": "input",
      "usage": "编号 steer|queue|cancel",
      "description": "处理提示卡给出的待确认消息；继续使用原记录目标、原操作者权限和能力检查。cancel 不等于停止已执行任务。"
    }
  },
  {
    "name": "access",
    "aliases": [],
    "help": {
      "section": "access",
      "usage": "[identity|all]",
      "description": "查看本人在当前聊天的 Gateway 准入；管理员处理本聊天申请，私聊 all 查看全部。identity 登记管理员候选身份，不自动授予管理员权。"
    }
  },
  {
    "name": "role",
    "aliases": [],
    "help": {
      "section": "access",
      "usage": "[用户ID或* viewer|participant|controller]",
      "description": "查看或设置聊天权限：viewer 只读，participant 可对话与插话，controller 另可停止、审批和管理权限。* 表示群默认角色，修改需要 controller。角色不替代设备或资源准入。"
    }
  },
  {
    "name": "share",
    "aliases": [],
    "help": {
      "section": "access",
      "usage": "claim [--ide]；/share invite；/share requests|list；/share approve 申请ID [--ide read|write] [--files] [--hours 24]；/share revoke 授权ID",
      "description": "会话提供者在设备端确认所有权并审批准入，将指定会话及可选目录、文件权限授予他人。分享机器人、各自连接自己的 Connector 不需要此流程。"
    }
  },
  {
    "name": "join",
    "aliases": [],
    "help": {
      "section": "access",
      "usage": "邀请码",
      "description": "申请指定共享会话访问，等待提供者审批；不会获得该设备的全部资源。"
    }
  },
  {
    "name": "approve",
    "aliases": [
      "ok"
    ],
    "capability": "approvals",
    "record": true,
    "help": {
      "section": "access",
      "usage": "[A编号]",
      "description": "批准当前渠道收到的原结构化审批，并等待原生确认；按原请求执行器处理，不因换绑改变。终端界面提示不能用此命令代替按键处理。"
    }
  },
  {
    "name": "reject",
    "aliases": [
      "no"
    ],
    "capability": "approvals",
    "record": true,
    "help": {
      "section": "access",
      "usage": "[A编号]",
      "description": "拒绝原结构化审批；继续使用原请求所属执行器，不等同停止任务。"
    }
  },
  {
    "name": "answer",
    "aliases": [],
    "capability": "userInput",
    "record": true,
    "help": {
      "section": "access",
      "usage": "[list]；/answer Q编号 回答内容；/answer Q编号 --option 1",
      "description": "查看或回答原结构化问题，只回复原请求，不作为普通对话或审批。不能回答终端中没有结构化请求 ID 的提示。"
    }
  },
  {
    "name": "skip",
    "aliases": [],
    "capability": "userInput",
    "record": true,
    "help": {
      "section": "access",
      "usage": "Q编号",
      "description": "按原问题允许的范围跳过，不等于批准操作；仍按原请求目标处理。"
    }
  },
  {
    "name": "mode",
    "aliases": [
      "v",
      "view"
    ],
    "help": {
      "section": "workflow",
      "usage": "[session|task|qa]",
      "description": "查看或切换已启用的项目工作模式；task 对应 /task，qa 对应 /qa。它是 Gateway 工作模式，不是原生计划模式。",
      "terminal": {
        "description": "查看或切换已启用的项目工作模式；Herdr 的 QA 结构化工具工作流尚未适配，qa 会明确拒绝。"
      }
    }
  },
  {
    "name": "qa",
    "aliases": [
      "q"
    ],
    "help": {
      "section": "workflow",
      "description": "进入项目绑定 llm-wiki 的问答模式，等同 /mode qa；需要已启用 QA、可用知识库和结构化工具能力。",
      "terminal": {
        "description": "现有 QA 工作流依赖结构化工具调用，终端工作流尚未适配；不会改变模式或发送输入。"
      }
    }
  },
  {
    "name": "task",
    "aliases": [
      "tb"
    ],
    "help": {
      "section": "workflow",
      "usage": "[ISSUE编号|new|todo|start|detail|comment|attach|block|review|accept|return]",
      "description": "进入项目 Taskboard 并操作工作流；/mode task 也是进入入口。选择 Issue 可绑定、继续相应任务；需要启用 Taskboard。"
    }
  },
  {
    "name": "plan",
    "aliases": [],
    "capability": "collaborationModes",
    "help": {
      "section": "capabilities",
      "usage": "[on|off]",
      "description": "切换原生计划模式；无参数也会切换，并非只读查询。使用 on/off 明确设置；不等同 Gateway 的 /mode。",
      "terminal": {
        "description": "需要运行接口提供结构化计划模式；不会注入计划提示词冒充原生设置。"
      }
    }
  },
  {
    "name": "goal",
    "aliases": [],
    "capability": "goals",
    "help": {
      "section": "capabilities",
      "usage": "[目标|pause|resume|complete|clear]",
      "description": "查看、设置或管理原生 thread 目标，不等同任务板验收。",
      "terminal": {
        "description": "需要运行接口提供原生目标操作，不以终端 done 字样推断目标完成。"
      }
    }
  },
  {
    "name": "balance",
    "aliases": [
      "bal"
    ],
    "capability": "accountRateLimits",
    "help": {
      "section": "capabilities",
      "description": "查看当前原生账号剩余用量；不合并不同 agent 账号。",
      "terminal": {
        "description": "需要运行接口提供账号用量查询。"
      }
    }
  }
] as const satisfies readonly ChannelCommandDefinition[];
export type ChannelCommandName = typeof CHANNEL_COMMAND_REGISTRY[number]["name"];
export const CHANNEL_COMMAND_ALIASES: Readonly<Record<string, string>> = Object.fromEntries(CHANNEL_COMMAND_REGISTRY.flatMap(command => command.aliases.map(alias => [alias, command.name])));
