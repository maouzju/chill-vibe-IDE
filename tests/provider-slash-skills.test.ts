import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { prepareProviderSkillReuse } from '../server/provider-skills.ts'
import { getProviderSlashCommands } from '../server/providers.ts'

const skillHomeEnvKeys = ['HOME', 'USERPROFILE', 'CODEX_HOME', 'CLAUDE_HOME', 'CLAUDE_CONFIG_DIR'] as const

const writeSkill = async (
  root: string,
  provider: 'codex' | 'claude',
  name: string,
  description: string,
) => {
  const skillDir = path.join(root, `.${provider}`, 'skills', name)
  await mkdir(skillDir, { recursive: true })
  const skillPath = path.join(skillDir, 'SKILL.md')
  await writeFile(
    skillPath,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    'utf8',
  )
  return skillPath
}

const withTemporarySkillHome = async <T>(homePath: string, callback: () => Promise<T>) => {
  const originalEnv = new Map<(typeof skillHomeEnvKeys)[number], string | undefined>(
    skillHomeEnvKeys.map((key) => [key, process.env[key]]),
  )

  process.env.HOME = homePath
  process.env.USERPROFILE = homePath
  delete process.env.CODEX_HOME
  delete process.env.CLAUDE_HOME
  delete process.env.CLAUDE_CONFIG_DIR

  try {
    return await callback()
  } finally {
    for (const key of skillHomeEnvKeys) {
      const originalValue = originalEnv.get(key)
      if (originalValue === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originalValue
      }
    }
  }
}

test('codex slash commands include current-provider and cross-provider skills when reuse is enabled', async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-skill-discovery-'))

  try {
    const codexSkillPath = await writeSkill(
      workspacePath,
      'codex',
      'check-all',
      'Run the broad validation workflow',
    )
    const claudeSkillPath = await writeSkill(
      workspacePath,
      'claude',
      'agent-reach',
      'Search the web and supported platforms',
    )

    const commands = await getProviderSlashCommands({
      provider: 'codex',
      workspacePath,
      language: 'en',
      crossProviderSkillReuseEnabled: true,
    })

    assert.equal(commands.some((command) => command.name === 'init' && command.source === 'native'), true)
    assert.equal(commands.some((command) => command.name === 'plan' && command.source === 'native'), true)

    const checkAll = commands.find((command) => command.name === 'check-all')
    const agentReach = commands.find((command) => command.name === 'agent-reach')

    assert.equal(checkAll?.source, 'skill')
    assert.equal(checkAll?.skillProvider, 'codex')
    assert.equal(checkAll?.skillPath, codexSkillPath)
    assert.equal(checkAll?.description, 'Run the broad validation workflow')

    assert.equal(agentReach?.source, 'skill')
    assert.equal(agentReach?.skillProvider, 'claude')
    assert.equal(agentReach?.skillPath, claudeSkillPath)
    assert.equal(agentReach?.description, 'Search the web and supported platforms')
  } finally {
    await rm(workspacePath, { recursive: true, force: true })
  }
})

test('codex slash commands include current-provider and cross-provider skills from the user home', async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-skill-home-workspace-'))
  const homePath = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-skill-home-'))

  try {
    const codexSkillPath = await writeSkill(
      homePath,
      'codex',
      'home-codex-skill',
      'Run a Codex home skill',
    )
    const claudeSkillPath = await writeSkill(
      homePath,
      'claude',
      'home-claude-skill',
      'Run a Claude home skill',
    )

    await withTemporarySkillHome(homePath, async () => {
      const commands = await getProviderSlashCommands({
        provider: 'codex',
        workspacePath,
        language: 'en',
        crossProviderSkillReuseEnabled: true,
      })

      const codexSkill = commands.find((command) => command.name === 'home-codex-skill')
      const claudeSkill = commands.find((command) => command.name === 'home-claude-skill')

      assert.equal(codexSkill?.source, 'skill')
      assert.equal(codexSkill?.skillProvider, 'codex')
      assert.equal(codexSkill?.skillPath, codexSkillPath)
      assert.equal(codexSkill?.description, 'Run a Codex home skill')

      assert.equal(claudeSkill?.source, 'skill')
      assert.equal(claudeSkill?.skillProvider, 'claude')
      assert.equal(claudeSkill?.skillPath, claudeSkillPath)
      assert.equal(claudeSkill?.description, 'Run a Claude home skill')
    })
  } finally {
    await rm(workspacePath, { recursive: true, force: true })
    await rm(homePath, { recursive: true, force: true })
  }
})

test('same-name skills win over native slash commands in completion metadata', async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-skill-priority-'))
  const homePath = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-skill-priority-home-'))

  try {
    const skillPath = await writeSkill(workspacePath, 'codex', 'plan', 'Run the plan skill workflow')

    await withTemporarySkillHome(homePath, async () => {
      const commands = await getProviderSlashCommands({
        provider: 'codex',
        workspacePath,
        language: 'en',
        crossProviderSkillReuseEnabled: true,
      })

      const planCommands = commands.filter((command) => command.name === 'plan')
      assert.equal(planCommands.length, 1)
      assert.equal(planCommands[0]?.source, 'skill')
      assert.equal(planCommands[0]?.skillPath, skillPath)
      assert.equal(planCommands[0]?.description, 'Run the plan skill workflow')
    })
  } finally {
    await rm(workspacePath, { recursive: true, force: true })
    await rm(homePath, { recursive: true, force: true })
  }
})

test('same-name cross-provider skills map to the current codex version for codex runs', async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-skill-provider-priority-'))
  const homePath = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-skill-provider-priority-home-'))

  try {
    const codexSkillPath = await writeSkill(
      workspacePath,
      'codex',
      'shared-review',
      'Codex-native review workflow',
    )
    const claudeSkillPath = await writeSkill(
      workspacePath,
      'claude',
      'shared-review',
      'Claude-native review workflow',
    )

    await withTemporarySkillHome(homePath, async () => {
      const codexCommands = await getProviderSlashCommands({
        provider: 'codex',
        workspacePath,
        language: 'en',
        crossProviderSkillReuseEnabled: true,
      })
      const codexMatches = codexCommands.filter((command) => command.name === 'shared-review')

      assert.equal(codexMatches.length, 1)
      assert.equal(codexMatches[0]?.skillProvider, 'codex')
      assert.equal(codexMatches[0]?.skillPath, codexSkillPath)
      assert.notEqual(codexMatches[0]?.skillPath, claudeSkillPath)
    })
  } finally {
    await rm(workspacePath, { recursive: true, force: true })
    await rm(homePath, { recursive: true, force: true })
  }
})

test('cross-provider instructions map same-name skills to the current claude version', async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-skill-claude-priority-'))
  const homePath = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-skill-claude-priority-home-'))

  try {
    await writeSkill(workspacePath, 'claude', 'shared-review', 'Claude-native review workflow')
    const codexShadowedSkillPath = await writeSkill(
      workspacePath,
      'codex',
      'shared-review',
      'Codex duplicate review workflow',
    )
    const codexOnlySkillPath = await writeSkill(
      workspacePath,
      'codex',
      'codex-only',
      'Codex-only workflow',
    )

    await withTemporarySkillHome(homePath, async () => {
      const prepared = await prepareProviderSkillReuse({
        provider: 'claude',
        workspacePath,
        language: 'en',
        prompt: 'Review this change.',
        crossProviderSkillReuseEnabled: true,
      })

      assert.match(prepared.systemInstructions, /codex-only \(codex\)/)
      assert.ok(prepared.systemInstructions.includes(codexOnlySkillPath))
      assert.doesNotMatch(prepared.systemInstructions, /shared-review \(codex\)/)
      assert.ok(!prepared.systemInstructions.includes(codexShadowedSkillPath))
    })
  } finally {
    await rm(workspacePath, { recursive: true, force: true })
    await rm(homePath, { recursive: true, force: true })
  }
})

test('codex slash commands do not import opposite-provider skills when reuse is disabled', async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-skill-isolation-'))

  try {
    await writeSkill(workspacePath, 'codex', 'check-all', 'Run the broad validation workflow')
    await writeSkill(workspacePath, 'claude', 'agent-reach', 'Search the web and supported platforms')

    const commands = await getProviderSlashCommands({
      provider: 'codex',
      workspacePath,
      language: 'en',
      crossProviderSkillReuseEnabled: false,
    })

    assert.equal(commands.some((command) => command.name === 'check-all' && command.source === 'skill'), true)
    assert.equal(commands.some((command) => command.name === 'agent-reach' && command.source === 'skill'), false)
  } finally {
    await rm(workspacePath, { recursive: true, force: true })
  }
})
