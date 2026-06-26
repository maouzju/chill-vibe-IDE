import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const chatCardSourcePath = path.join(process.cwd(), 'src', 'components', 'ChatCard.tsx')

test('ChatCard does not auto-persist auto urge profile selection while cards mount', async () => {
  const source = await readFile(chatCardSourcePath, 'utf8')
  const profilePersistCalls = source.match(/(?:patchCard|onPatchCard)\(\{\s*autoUrgeProfileId:/g) ?? []

  assert.equal(
    profilePersistCalls.length,
    1,
    'autoUrgeProfileId should only be persisted from the explicit profile dropdown, not from mount/effect sync',
  )
  assert.match(
    source,
    /onChange=\{\(event\) => \{[\s\S]*?onPatchCard\(\{\s*autoUrgeProfileId:\s*nextProfileId\s*\}\)/,
  )
})
