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
      }
    : {
        git: ['git'],
        node: ['node'],
        claude: ['claude'],
        codex: ['codex'],
      }

const checkLabels: Record<EnvironmentCheckId, string> = {
  git: 'Git',
  node: 'Node.js',
  claude: 'Claude CLI',
  codex: 'Codex CLI',
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
  const checks = await Promise.all(
    (['git', 'node', 'claude', 'codex'] as const).map(async (id) => ({
      id,
      label: checkLabels[id],
      available:
        ((id === 'claude' || id === 'codex') && (await resolveCompatCommand(id)) !== null) ||
        (await resolveCommand(id)),
    })),
  )

  return {
    environment: {
      ready: checks.every((check) => check.available),
      checks,
    },
    ccSwitch: await getCcSwitchStatus(),
  }
}
