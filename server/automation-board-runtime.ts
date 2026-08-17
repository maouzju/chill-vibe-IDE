import { fileURLToPath } from 'node:url'

import type { AppLanguage } from '../shared/schema.js'

export const workspaceAdminMcpServerName = 'chill_vibe_workspace'
export const workspaceAdminMcpUrlEnvKey = 'CHILL_VIBE_ADMIN_MCP_URL'
export const workspaceAdminMcpTokenEnvKey = 'CHILL_VIBE_ADMIN_MCP_TOKEN'
export const workspaceAdminMcpColumnIdEnvKey = 'CHILL_VIBE_ADMIN_MCP_COLUMN_ID'
export const workspaceAdminMcpSelfCardIdEnvKey = 'CHILL_VIBE_ADMIN_MCP_SELF_CARD_ID'

export type WorkspaceAdminMcpLaunchInput = {
  /** Loopback bridge base URL, e.g. http://127.0.0.1:54321 */
  url: string
  token: string
  /** The workspace column this session is allowed to operate on. */
  columnId: string
  /** The requesting card itself, filtered out of the session listing. */
  selfCardId: string
  /** Absolute path to automation-board-mcp.js. */
  scriptPath: string
  /** Node/Electron executable that will run the script. */
  execPath: string
  /** True on the Electron host, where the exec path needs ELECTRON_RUN_AS_NODE. */
  isElectron: boolean
}

// 与 archive-recall.ts 的同名私有 helper 行为一致（那两个不导出，所以复制而
// 不是 import）：codex 的 `-c key=value` 值就是一段 TOML 字面量，Windows 路径
// 里的反斜杠必须转义，否则 `D:\Git\...\mcp.js` 的 \G 会被 TOML 解析器吃掉。
const formatTomlString = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

const formatTomlStringArray = (values: string[]) =>
  `[${values.map((value) => formatTomlString(value)).join(', ')}]`

export const getWorkspaceAdminMcpScriptPath = () =>
  fileURLToPath(new URL('./automation-board-mcp.js', import.meta.url))

const buildWorkspaceAdminMcpEnv = ({
  url,
  token,
  columnId,
  selfCardId,
  isElectron,
}: Pick<
  WorkspaceAdminMcpLaunchInput,
  'url' | 'token' | 'columnId' | 'selfCardId' | 'isElectron'
>) => {
  const envEntries: Record<string, string> = {
    [workspaceAdminMcpUrlEnvKey]: url,
    [workspaceAdminMcpTokenEnvKey]: token,
    [workspaceAdminMcpColumnIdEnvKey]: columnId,
    [workspaceAdminMcpSelfCardIdEnvKey]: selfCardId,
  }

  if (isElectron) {
    envEntries.ELECTRON_RUN_AS_NODE = '1'
  }

  return envEntries
}

export const buildWorkspaceAdminCodexRuntimeArgs = ({
  url,
  token,
  columnId,
  selfCardId,
  scriptPath,
  execPath,
  isElectron,
}: WorkspaceAdminMcpLaunchInput): string[] => {
  const runtimeArgs = [
    '-c',
    `mcp_servers.${workspaceAdminMcpServerName}.command=${formatTomlString(execPath)}`,
    '-c',
    `mcp_servers.${workspaceAdminMcpServerName}.args=${formatTomlStringArray([scriptPath])}`,
  ]

  const envEntries = buildWorkspaceAdminMcpEnv({ url, token, columnId, selfCardId, isElectron })
  for (const [key, value] of Object.entries(envEntries)) {
    runtimeArgs.push(
      '-c',
      `mcp_servers.${workspaceAdminMcpServerName}.env.${key}=${formatTomlString(value)}`,
    )
  }

  return runtimeArgs
}

export type WorkspaceAdminClaudeMcpConfig = {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>
}

export const buildWorkspaceAdminClaudeMcpConfig = ({
  url,
  token,
  columnId,
  selfCardId,
  scriptPath,
  execPath,
  isElectron,
}: WorkspaceAdminMcpLaunchInput): WorkspaceAdminClaudeMcpConfig => ({
  mcpServers: {
    [workspaceAdminMcpServerName]: {
      command: execPath,
      args: [scriptPath],
      env: buildWorkspaceAdminMcpEnv({ url, token, columnId, selfCardId, isElectron }),
    },
  },
})

// 这段只讲"你有什么权限、5 个工具各是什么、写工具的语义边界"。
// **刻意不讲"该怎么当监工"** —— 那属于模板的需求文本（见 v2 设计的"系统提示"
// 一节）：开这个开关的可能是任何会话，不一定是监工。
const workspaceAdminInstructionZh =
  '你被授予了这个工作区的超管权限：可以查看并操作同一个工作区列里的其它会话（既包括自动化看板上的项，也包括普通 tab 里的会话）。'
  + `你有 7 个 ${workspaceAdminMcpServerName} MCP 工具：`
  + 'list_sessions 列出本工作区全部会话（cardId、标题、provider/模型、运行状态、是否在某张看板的哪条泳道、原始需求、已静默多少分钟、最后一条消息预览）；'
  + 'read_session 读某个会话最近的转录，用来判断它到底交付了没有；'
  + 'create_session 新建一个会话并派给它一段需求 —— 需要再开一个 agent 时用它，包括这个工作区现在一张卡都没有、其它工具无对象可操作的时候；'
  + 'lane=running（默认）是建好就把需求作为第一条消息发出去，lane=standby 是先建好、需求存进草稿、之后再用 move_session_to_lane 启动；'
  + '本工作区有看板就建成看板项，没有看板就建成普通 tab 会话；新会话不会继承你的超管权限。'
  + 'send_session_message 把一句话发进那个会话自己的聊天里 —— 这就是"鞭策"，消息会像用户亲自输入一样出现在那张卡的对话里；'
  + 'move_session_to_lane 把某个会话移进看板的某条泳道（standby 待办 / running 正在执行 / done 已完成；移到 running 会开始执行，移到 standby/done 会中断执行）；'
  + 'set_session_wake_timer 给某个会话挂计划唤醒（mode=duration 就是"过 N 分钟再回来看"）；'
  + 'wake_me_when_sessions_finish 登记"等这些会话跑完再叫醒我"，然后**立刻结束你这一回合** —— '
  + '目标跑完（或到了 timeoutMinutes 上限，默认 60 分钟）时，你写的 note 会作为你的下一条消息把你唤起。'
  + '这就是监工的正确姿势：派活 → 登记等待 → 闭嘴。'
  + '**不要**改成反复调 list_sessions 干等：你熬不过被你监工的 agent，只会把上下文烧光；'
  + '被唤醒之后监工也没有结束，只要还有活在跑，就再登记一次。'
  + '你自己不在 list_sessions 的结果里，不用找自己。'
  + '写工具（create_session / send_session_message / move_session_to_lane / set_session_wake_timer / wake_me_when_sessions_finish）返回的只是"命令已投递"，不代表已生效 —— 要确认结果就再调一次 list_sessions。'
  + '不要替这些 agent 自己动手改代码：你操作的是会话，不是它们的仓库。'

const workspaceAdminInstructionEn =
  'You have been granted admin access to this workspace: you can inspect and operate the other sessions in the same workspace column (both automation-board items and ordinary tab sessions). '
  + `You have 7 ${workspaceAdminMcpServerName} MCP tools: `
  + 'list_sessions lists every session in this workspace (cardId, title, provider/model, run status, which board lane it sits in if any, its original requirement, how many minutes it has been silent, and a preview of its last message); '
  + 'read_session reads one session\'s recent transcript so you can judge whether it actually delivered; '
  + 'create_session creates a NEW session and hands it a requirement — use it when the work needs another agent, including when this workspace has no sessions at all and the other tools have nothing to operate on; '
  + 'lane=running (the default) sends the requirement immediately, lane=standby parks it in the new session\'s draft for you to start later with move_session_to_lane; '
  + 'it becomes a board item if this workspace has a board and an ordinary tab session otherwise, and it does not inherit your admin access; '
  + 'send_session_message posts a message into that session\'s own chat — this is what "鞭策" (nudging) means here, and the message appears in that card\'s conversation exactly as if the user had typed it; '
  + 'move_session_to_lane moves a session into a board lane (standby / running / done; moving to running starts execution, moving to standby or done interrupts it); '
  + 'set_session_wake_timer arms a wake timer on a session (mode=duration means "check back after N minutes"); '
  + 'wake_me_when_sessions_finish registers "wake me once these sessions finish" and then you **end your turn immediately** — '
  + 'when the targets finish (or timeoutMinutes elapses, default 60), the note you wrote is delivered as your next message and wakes you back up. '
  + 'That is what supervising looks like here: dispatch, register the wait, stop talking. '
  + 'Do **not** poll list_sessions in a loop instead — you cannot outlast the agents you supervise and you will only burn the context you need later; '
  + 'and waking up does not end your supervision: register another wait whenever work is still in flight. '
  + 'You are not included in the list_sessions output, so do not look for yourself. '
  + 'The write tools (create_session / send_session_message / move_session_to_lane / set_session_wake_timer / wake_me_when_sessions_finish) only report that the command was delivered, not that it took effect — call list_sessions again to confirm. '
  + 'Do not do these agents\' coding work yourself: what you operate on is sessions, not their repositories.'

export const getWorkspaceAdminInstruction = (language: AppLanguage) =>
  language === 'en' ? workspaceAdminInstructionEn : workspaceAdminInstructionZh
