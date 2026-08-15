import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCodexArgs } from '../server/providers.js'
import { buildWhitenoiseCliArgs } from '../server/whitenoise/whitenoise-generator.js'
import type { ChatRequest } from '../shared/schema.js'

// 症状：2026-08-14 用 codex-cli 0.144.1 跑 `codex exec ... --ask-for-approval never` 直接
//       退出，stderr 只有一行 `error: unexpected argument '--ask-for-approval' found`；
//       `-q` 同样报废。白噪音生成（唯一还走 exec 的 codex 分支）因此 100% 起不来。
// 根因：codex exec 是非交互模式，本来就不会弹审批，0.144 把 `--ask-for-approval` / `-q`
//       这两个自 exec 诞生起就是空操作的开关整个删掉了；我们的 argv 还按老版本拼。
// 为什么不能直接删掉审批参数了事：`approval_policy` 仍是真实配置项，用户 config.toml 里
//       可能写着别的值，argv 必须继续显式钉死 never。`-c approval_policy="never"` 在新旧
//       CLI 上都受支持（0.144 的 `-c` 明确接受任意 config 覆盖），是唯一向后兼容的写法。
const codexRemovedExecFlags = ['--ask-for-approval', '-q']

const createCodexRequest = (overrides: Partial<ChatRequest> = {}): ChatRequest =>
  ({
    provider: 'codex',
    prompt: 'hello',
    workspacePath: process.cwd(),
    language: 'en',
    ...overrides,
  }) as ChatRequest

test('codex exec argv drops flags removed by codex-cli 0.144', () => {
  const args = buildCodexArgs(createCodexRequest(), [])

  for (const flag of codexRemovedExecFlags) {
    assert.ok(!args.includes(flag), `codex exec argv must not pass ${flag} (removed in codex-cli 0.144)`)
  }
})

test('codex exec argv still pins the approval policy through -c', () => {
  const args = buildCodexArgs(createCodexRequest(), [])

  assert.ok(
    args.includes('approval_policy="never"'),
    'codex exec argv must keep pinning approval_policy=never via -c',
  )
})

test('white-noise codex argv drops flags removed by codex-cli 0.144', () => {
  const args = buildWhitenoiseCliArgs('codex', 'PROMPT', ['--runtime-flag'])

  for (const flag of codexRemovedExecFlags) {
    assert.ok(!args.includes(flag), `white-noise codex argv must not pass ${flag}`)
  }

  assert.ok(
    args.includes('approval_policy="never"'),
    'white-noise codex argv must keep pinning approval_policy=never via -c',
  )
  assert.equal(args.at(-1), 'PROMPT', 'prompt must stay the trailing positional argument')
})
