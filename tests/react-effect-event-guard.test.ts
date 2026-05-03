import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const projectRoot = process.cwd()

describe('React effect-event startup guard', () => {
  it('keeps startup-critical chat components off React useEffectEvent', async () => {
    const guardedFiles = [
      path.join(projectRoot, 'src', 'components', 'ChatCard.tsx'),
      path.join(projectRoot, 'src', 'components', 'StructuredBlocks.tsx'),
    ]

    for (const filePath of guardedFiles) {
      const source = await readFile(filePath, 'utf8')
      assert.equal(
        source.includes('useEffectEvent'),
        false,
        `${path.relative(projectRoot, filePath)} should not use React useEffectEvent`,
      )
    }
  })
})
