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
  + `你有 5 个 ${workspaceAdminMcpServerName} MCP 工具：`
  + 'list_sessions 列出本工作区全部会话（cardId、标题、provider/模型、运行状态、是否在某张看板的哪条泳道、原始需求、已静默多少分钟、最后一条消息预览）；'
  + 'read_session 读某个会话最近的转录，用来判断它到底交付了没有；'
  + 'send_session_message 把一句话发进那个会话自己的聊天里 —— 这就是"鞭策"，消息会像用户亲自输入一样出现在那张卡的对话里；'
  + 'move_session_to_lane 把某个会话移进看板的某条泳道（standby 待办 / running 正在执行 / done 已完成；移到 running 会开始执行，移到 standby/done 会中断执行）；'
  + 'set_session_wake_timer 给某个会话挂计划唤醒（mode=duration 就是"过 N 分钟再回来看"）。'
  + '你自己不在 list_sessions 的结果里，不用找自己。'
  + '写工具（send_session_message / move_session_to_lane / set_session_wake_timer）返回的只是"命令已投递"，不代表已生效 —— 要确认结果就再调一次 list_sessions。'
  + '不要替这些 agent 自己动手改代码：你操作的是会话，不是它们的仓库。'

const workspaceAdminInstructionEn =
  'You have been granted admin access to this workspace: you can inspect and operate the other sessions in the same workspace column (both automation-board items and ordinary tab sessions). '
  + `You have 5 ${workspaceAdminMcpServerName} MCP tools: `
  + 'list_sessions lists every session in this workspace (cardId, title, provider/model, run status, which board lane it sits in if any, its original requirement, how many minutes it has been silent, and a preview of its last message); '
  + 'read_session reads one session\'s recent transcript so you can judge whether it actually delivered; '
  + 'send_session_message posts a message into that session\'s own chat — this is what "鞭策" (nudging) means here, and the message appears in that card\'s conversation exactly as if the user had typed it; '
  + 'move_session_to_lane moves a session into a board lane (standby / running / done; moving to running starts execution, moving to standby or done interrupts it); '
  + 'set_session_wake_timer arms a wake timer on a session (mode=duration means "check back after N minutes"). '
  + 'You are not included in the list_sessions output, so do not look for yourself. '
  + 'The write tools (send_session_message / move_session_to_lane / set_session_wake_timer) only report that the command was delivered, not that it took effect — call list_sessions again to confirm. '
  + 'Do not do these agents\' coding work yourself: what you operate on is sessions, not their repositories.'

export const getWorkspaceAdminInstruction = (language: AppLanguage) =>
  language === 'en' ? workspaceAdminInstructionEn : workspaceAdminInstructionZh
