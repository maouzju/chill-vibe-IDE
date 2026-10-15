import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { resolveCompatCommand } from './cli-compat-manager.js'
import { decodeConsoleOutput } from './file-encoding.js'

import type { EnvironmentCheckId, OnboardingStatus } from '../shared/schema.js'

const commandLookupTool = process.platform === 'win32' ? 'where.exe' : 'which'
const ccSwitchDbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db')
const ccSwitchSourceLabel = '~/.cc-switch/cc-switch.db'

const commandCandidatesByCheck: Record<EnvironmentCheckId, string[]> =
  process.platform === 'win32'
    ? {
        git: ['git.exe', 'git.cmd', 'git'],
        node: ['node.exe', 'node.cmd', 'node'],
        claude: ['claude.exe', 'claude.cmd', 'claude'],
        codex: ['codex.exe', 'codex.cmd', 'codex'],
        gemini: ['gemini.cmd', 'gemini.exe', 'gemini'],
      }
    : {
        git: ['git'],
        node: ['node'],
        claude: ['claude'],
        codex: ['codex'],
        gemini: ['gemini'],
      }

const checkLabels: Record<EnvironmentCheckId, string> = {
  git: 'Git',
  node: 'Node.js',
  claude: 'Claude CLI',
  codex: 'Codex CLI',
  gemini: 'Gemini CLI',
}

// Gemini 是第三个、可选的 provider：多数用户只用 Claude/Codex，缺它就把整个环境判成未就绪会
// 让引导弹窗反复催装一个用不到的工具。
const optionalChecks = new Set<EnvironmentCheckId>(['gemini'])

export const summarizeEnvironmentChecks = (
  results: ReadonlyArray<{ id: EnvironmentCheckId; available: boolean }>,
): OnboardingStatus['environment'] => {
  const checks = results.map(({ id, available }) => ({
    id,
    label: checkLabels[id],
    available,
    ...(optionalChecks.has(id) ? { optional: true } : {}),
  }))
  return {
    ready: checks.every((check) => check.available || check.optional),
    checks,
  }
}

const resolveCommand = async (checkId: EnvironmentCheckId) =>
  new Promise<boolean>((resolve) => {
    const child = spawn(commandLookupTool, commandCandidatesByCheck[checkId], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })

    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })

    child.on('close', () => {
      const matches = decodeConsoleOutput(chunks)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

      resolve(matches.length > 0)
    })

    child.on('error', () => resolve(false))
  })

const getCcSwitchStatus = async () => {
  try {
    await access(ccSwitchDbPath)
    return {
      available: true,
      source: ccSwitchSourceLabel,
    }
  } catch {
    return {
      available: false,
    }
  }
}

export const inspectOnboardingStatus = async (): Promise<OnboardingStatus> => {
  const results = await Promise.all(
    (['git', 'node', 'claude', 'codex', 'gemini'] as const).map(async (id) => ({
      id,
      available:
        ((id === 'claude' || id === 'codex' || id === 'gemini') && (await resolveCompatCommand(id)) !== null) ||
        (await resolveCommand(id)),
    })),
  )

  return {
    environment: summarizeEnvironmentChecks(results),
    ccSwitch: await getCcSwitchStatus(),
  }
}
