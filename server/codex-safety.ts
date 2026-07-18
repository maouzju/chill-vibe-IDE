import crypto from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AppLanguage, ChatRequest } from '../shared/schema.js'
import { getAppDataDir } from './app-paths.js'

const safetyHookMatcher = 'Bash|apply_patch|Edit|Write'
const safetyHookTimeoutSec = 5
const guardScriptPath = fileURLToPath(new URL('./codex-destructive-command-guard.js', import.meta.url))
const safetyEnvironmentKeys = [
  'CHILL_VIBE_PROTECTED_HOME',
  'CHILL_VIBE_PROTECTED_WORKSPACE',
  'CHILL_VIBE_PROTECTED_CODEX_HOME',
  'CHILL_VIBE_PROTECTED_APP_DATA',
  'CHILL_VIBE_CODEX_GUARD_EXECUTABLE',
  'CHILL_VIBE_CODEX_GUARD_SCRIPT',
  'CHILL_VIBE_CODEX_SAFETY_HOOK_COMMAND',
] as const

export type PreparedCodexSafetyRuntime = {
  args: string[]
  env: NodeJS.ProcessEnv
  hookCommand?: string
}

export type PreparedDestructiveCommandGuardRuntime = {
  env: NodeJS.ProcessEnv
  hookCommand?: string
}

const formatTomlString = (value: string) => JSON.stringify(value)

const normalizeHookCommand = (value: string) =>
  value.trim().replace(/^(["'])(.*)\1$/, '$2').replace(/[\\/]+/g, path.sep).toLowerCase()

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

const writeLauncherIfNeeded = async (launcherPath: string, content: string) => {
  const current = await readFile(launcherPath, 'utf8').catch(() => null)
  if (current === content) {
    return
  }

  try {
    await writeFile(launcherPath, content, { encoding: 'utf8', flag: 'wx' })
  } catch {
    const afterConcurrentWrite = await readFile(launcherPath, 'utf8').catch(() => null)
    if (afterConcurrentWrite !== content) {
      await writeFile(launcherPath, content, 'utf8')
    }
  }
}

const writeSafetyLauncher = async (launcherPath: string) => {
  if (process.platform === 'win32') {
    const content = [
      '@echo off',
      'setlocal',
      'if not defined CHILL_VIBE_CODEX_GUARD_EXECUTABLE exit /b 2',
      'if not defined CHILL_VIBE_CODEX_GUARD_SCRIPT exit /b 2',
      'set "ELECTRON_RUN_AS_NODE=1"',
      '"%CHILL_VIBE_CODEX_GUARD_EXECUTABLE%" "%CHILL_VIBE_CODEX_GUARD_SCRIPT%"',
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n')
    await writeLauncherIfNeeded(launcherPath, content)
    return
  }

  const content = [
    '#!/bin/sh',
    '[ -n "$CHILL_VIBE_CODEX_GUARD_EXECUTABLE" ] || exit 2',
    '[ -n "$CHILL_VIBE_CODEX_GUARD_SCRIPT" ] || exit 2',
    'export ELECTRON_RUN_AS_NODE=1',
    'exec "$CHILL_VIBE_CODEX_GUARD_EXECUTABLE" "$CHILL_VIBE_CODEX_GUARD_SCRIPT"',
    '',
  ].join('\n')
  await writeLauncherIfNeeded(launcherPath, content)
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

export const prepareDestructiveCommandGuardRuntime = async (
  request: ChatRequest,
  baseEnv: NodeJS.ProcessEnv,
  options?: {
    originalHome?: string
    originalCodexHome?: string
  },
): Promise<PreparedDestructiveCommandGuardRuntime> => {
  const env = { ...baseEnv }

  for (const key of safetyEnvironmentKeys) {
    delete env[key]
  }

  if (request.codexDestructiveCommandProtectionEnabled !== true) {
    return { env }
  }

  const appDataDir = getAppDataDir()
  const originalHome = options?.originalHome ?? resolveOriginalHome(baseEnv)
  const originalCodexHome =
    options?.originalCodexHome ?? resolveOriginalCodexHome(baseEnv, originalHome)
  const safetyDir = path.join(appDataDir, 'codex-safety')
  await mkdir(safetyDir, { recursive: true })
  const launcherPath = path.join(
    safetyDir,
    process.platform === 'win32' ? 'pre-tool-use-guard.cmd' : 'pre-tool-use-guard.sh',
  )
  await writeSafetyLauncher(launcherPath)

  env.CHILL_VIBE_PROTECTED_HOME = originalHome
  env.CHILL_VIBE_PROTECTED_WORKSPACE = path.resolve(request.workspacePath)
  env.CHILL_VIBE_PROTECTED_CODEX_HOME = originalCodexHome
  env.CHILL_VIBE_PROTECTED_APP_DATA = appDataDir
  env.CHILL_VIBE_CODEX_GUARD_EXECUTABLE = process.execPath
  env.CHILL_VIBE_CODEX_GUARD_SCRIPT = guardScriptPath

  const hookCommand = process.platform === 'win32'
    ? `& '${launcherPath.replace(/'/g, "''")}'`
    : `'${launcherPath.replace(/'/g, `'"'"'`)}'`
  env.CHILL_VIBE_CODEX_SAFETY_HOOK_COMMAND = hookCommand

  return { env, hookCommand }
}

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

  const guardRuntime = await prepareDestructiveCommandGuardRuntime(request, env, {
    originalHome,
    originalCodexHome,
  })

  return {
    args: guardRuntime.hookCommand
      ? [...baseArgs, ...buildSafetyHookConfig(guardRuntime.hookCommand)]
      : [...baseArgs],
    env: guardRuntime.env,
    hookCommand: guardRuntime.hookCommand,
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
      filePath: null,
      expectedVersion: null,
      reloadUserConfig: true,
    })
    hook = readHookMetadata(await listHooks(), hookCommand)
  }

  if (!hook || !hook.enabled || !['trusted', 'managed'].includes(hook.trustStatus.toLowerCase())) {
    throw new Error(formatSafetySetupError(language, 'the hook trust verification did not persist'))
  }
}
