import crypto from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AppLanguage, ChatRequest } from '../shared/schema.js'
import { getAppDataDir } from './app-paths.js'

const safetyHookMatcher = 'Bash|apply_patch|Edit|Write'
const safetyHookTimeoutSec = 5
const guardScriptPath = fileURLToPath(new URL('./codex-destructive-command-guard.js', import.meta.url))

export type PreparedCodexSafetyRuntime = {
  args: string[]
  env: NodeJS.ProcessEnv
  hookCommand?: string
}

const formatTomlString = (value: string) => JSON.stringify(value)

const normalizeHookCommand = (value: string) =>
  value.trim().replace(/^(["'])(.*)\1$/, '$2').replace(/[\\/]+/g, path.sep).toLowerCase()

const escapeBatchValue = (value: string) => value.replace(/%/g, '%%')

const resolveOriginalHome = (env: NodeJS.ProcessEnv) =>
  env.CHILL_VIBE_PROTECTED_HOME?.trim() ||
  env.USERPROFILE?.trim() ||
  env.HOME?.trim() ||
  os.homedir()

const resolveOriginalCodexHome = (env: NodeJS.ProcessEnv, originalHome: string) =>
  env.CODEX_HOME?.trim() || path.join(originalHome, '.codex')

const buildRuntimeKey = (request: ChatRequest) =>
  crypto
    .createHash('sha256')
    .update(`${request.cardId?.trim() ?? ''}\0${path.resolve(request.workspacePath)}`)
    .digest('hex')
    .slice(0, 20)

const writeSafetyLauncher = async ({
  launcherPath,
  protectedHome,
  workspacePath,
  codexHome,
  appDataDir,
}: {
  launcherPath: string
  protectedHome: string
  workspacePath: string
  codexHome: string
  appDataDir: string
}) => {
  if (process.platform === 'win32') {
    const content = [
      '@echo off',
      'setlocal',
      'set "ELECTRON_RUN_AS_NODE=1"',
      `set "CHILL_VIBE_PROTECTED_HOME=${escapeBatchValue(protectedHome)}"`,
      `set "CHILL_VIBE_PROTECTED_WORKSPACE=${escapeBatchValue(workspacePath)}"`,
      `set "CHILL_VIBE_PROTECTED_CODEX_HOME=${escapeBatchValue(codexHome)}"`,
      `set "CHILL_VIBE_PROTECTED_APP_DATA=${escapeBatchValue(appDataDir)}"`,
      `"${process.execPath}" "${guardScriptPath}"`,
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n')
    await writeFile(launcherPath, content, 'utf8')
    return
  }

  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`
  const content = [
    '#!/bin/sh',
    `export ELECTRON_RUN_AS_NODE=1`,
    `export CHILL_VIBE_PROTECTED_HOME=${quote(protectedHome)}`,
    `export CHILL_VIBE_PROTECTED_WORKSPACE=${quote(workspacePath)}`,
    `export CHILL_VIBE_PROTECTED_CODEX_HOME=${quote(codexHome)}`,
    `export CHILL_VIBE_PROTECTED_APP_DATA=${quote(appDataDir)}`,
    `exec ${quote(process.execPath)} ${quote(guardScriptPath)}`,
    '',
  ].join('\n')
  await writeFile(launcherPath, content, 'utf8')
  await chmod(launcherPath, 0o700)
}

const buildSafetyHookConfig = (hookCommand: string) => [
  '-c',
  [
    'hooks.PreToolUse=[{',
    `matcher=${formatTomlString(safetyHookMatcher)},`,
    'hooks=[{',
    'type="command",',
    `command=${formatTomlString(hookCommand)},`,
    `command_windows=${formatTomlString(hookCommand)},`,
    `timeout=${safetyHookTimeoutSec},`,
    'statusMessage="Chill Vibe safety check"',
    '}]',
    '}]',
  ].join(' '),
]

export const prepareCodexSafetyRuntime = async (
  request: ChatRequest,
  baseArgs: string[],
  baseEnv: NodeJS.ProcessEnv,
): Promise<PreparedCodexSafetyRuntime> => {
  const env = { ...baseEnv }
  const appDataDir = getAppDataDir()
  const originalHome = resolveOriginalHome(baseEnv)
  const originalCodexHome = resolveOriginalCodexHome(baseEnv, originalHome)
  const runtimeKey = buildRuntimeKey(request)

  if (request.codexIsolatedHomeEnabled === true) {
    const isolatedHome = path.join(appDataDir, 'codex-agent-homes', runtimeKey)
    await mkdir(isolatedHome, { recursive: true })
    env.USERPROFILE = isolatedHome
    env.CODEX_HOME = originalCodexHome

    if (process.platform === 'win32') {
      // PowerShell derives its automatic $HOME from USERPROFILE. Keep an
      // existing HOME value so Git and other Unix-compatible Windows tools can
      // still find the user's global config; the command guard protects that
      // real path if a Bash-like command tries to delete $HOME directly.
      env.HOME = baseEnv.HOME ?? originalHome
      const parsed = path.win32.parse(isolatedHome)
      env.HOMEDRIVE = parsed.root.replace(/[\\/]+$/, '')
      env.HOMEPATH = isolatedHome.slice(parsed.root.length - 1)
    } else {
      env.HOME = isolatedHome
    }
  }

  if (request.codexDestructiveCommandProtectionEnabled !== true) {
    return { args: [...baseArgs], env }
  }

  const safetyDir = path.join(appDataDir, 'codex-safety')
  await mkdir(safetyDir, { recursive: true })
  const launcherPath = path.join(
    safetyDir,
    process.platform === 'win32'
      ? `pre-tool-use-guard-${runtimeKey}.cmd`
      : `pre-tool-use-guard-${runtimeKey}.sh`,
  )
  await writeSafetyLauncher({
    launcherPath,
    protectedHome: originalHome,
    workspacePath: request.workspacePath,
    codexHome: originalCodexHome,
    appDataDir,
  })

  const hookCommand = process.platform === 'win32'
    ? `& '${launcherPath.replace(/'/g, "''")}'`
    : `'${launcherPath.replace(/'/g, `'"'"'`)}'`
  env.CHILL_VIBE_CODEX_SAFETY_HOOK_COMMAND = hookCommand

  return {
    args: [...baseArgs, ...buildSafetyHookConfig(hookCommand)],
    env,
    hookCommand,
  }
}

type HookMetadata = {
  key: string
  eventName: string
  command: string
  source: string
  enabled: boolean
  currentHash: string
  trustStatus: string
}

const readHookMetadata = (
  result: unknown,
  expectedCommand: string,
): HookMetadata | null => {
  if (!result || typeof result !== 'object') {
    return null
  }
  const data = (result as { data?: unknown }).data
  if (!Array.isArray(data)) {
    return null
  }

  for (const entry of data) {
    const hooks = entry && typeof entry === 'object'
      ? (entry as { hooks?: unknown }).hooks
      : null
    if (!Array.isArray(hooks)) {
      continue
    }

    for (const rawHook of hooks) {
      if (!rawHook || typeof rawHook !== 'object') {
        continue
      }
      const hook = rawHook as Record<string, unknown>
      const metadata: HookMetadata = {
        key: typeof hook.key === 'string' ? hook.key : '',
        eventName: typeof hook.eventName === 'string' ? hook.eventName : '',
        command: typeof hook.command === 'string' ? hook.command : '',
        source: typeof hook.source === 'string' ? hook.source : '',
        enabled: hook.enabled === true,
        currentHash: typeof hook.currentHash === 'string' ? hook.currentHash : '',
        trustStatus: typeof hook.trustStatus === 'string' ? hook.trustStatus : '',
      }
      if (
        metadata.eventName.replace(/[^a-z]/gi, '').toLowerCase() === 'pretooluse' &&
        metadata.source.replace(/[^a-z]/gi, '').toLowerCase() === 'sessionflags' &&
        normalizeHookCommand(metadata.command) === normalizeHookCommand(expectedCommand)
      ) {
        return metadata
      }
    }
  }
  return null
}

const formatSafetySetupError = (language: AppLanguage, detail: string) =>
  language === 'en'
    ? `Codex destructive-command protection could not start safely: ${detail}. Update the local Codex CLI or turn off the protection in Settings only if you accept the risk.`
    : `Codex 高风险删除防护无法安全启动：${detail}。请更新本地 Codex CLI；只有在明确接受风险时，才在设置中关闭该防护。`

export const ensureCodexSafetyHookTrusted = async ({
  sendRequest,
  workspacePath,
  hookCommand,
  language,
}: {
  sendRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>
  workspacePath: string
  hookCommand: string
  language: AppLanguage
}) => {
  const listHooks = () => sendRequest('hooks/list', { cwds: [workspacePath] })
  let hook = readHookMetadata(await listHooks(), hookCommand)
  if (!hook) {
    throw new Error(formatSafetySetupError(language, 'the Chill Vibe PreToolUse hook was not discovered'))
  }

  if (!hook.enabled) {
    throw new Error(formatSafetySetupError(language, 'the Chill Vibe PreToolUse hook is disabled'))
  }

  if (!['trusted', 'managed'].includes(hook.trustStatus.toLowerCase())) {
    if (!hook.key || !hook.currentHash) {
      throw new Error(formatSafetySetupError(language, 'the hook did not expose a trust key and hash'))
    }
    await sendRequest('config/batchWrite', {
      edits: [
        {
          keyPath: 'hooks.state',
          value: {
            [hook.key]: {
              trusted_hash: hook.currentHash,
            },
          },
          mergeStrategy: 'upsert',
        },
      ],
      reloadUserConfig: true,
    })
    hook = readHookMetadata(await listHooks(), hookCommand)
  }

  if (!hook || !hook.enabled || !['trusted', 'managed'].includes(hook.trustStatus.toLowerCase())) {
    throw new Error(formatSafetySetupError(language, 'the hook trust verification did not persist'))
  }
}
