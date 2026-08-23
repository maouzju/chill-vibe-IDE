import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const skillText = readFileSync(
  new URL('../.codex/skills/release-pipeline/SKILL.md', import.meta.url),
  'utf8',
)

test('release pipeline publishes local main only after local-first integration', () => {
  const publishStart = skillText.indexOf(
    '5. Integrate into local `main`, push, prove convergence',
  )
  const publishEnd = skillText.indexOf('\n6. Let the workflow deliver the asset', publishStart)

  assert.ok(publishStart >= 0, 'publish step must define local-main integration')
  assert.ok(publishEnd > publishStart, 'publish step must have a bounded workflow section')

  const publishStep = skillText.slice(publishStart, publishEnd)
  const mergeIndex = publishStep.indexOf('git merge --ff-only release/v<version>')
  const pushIndex = publishStep.indexOf('git push origin main')
  const fetchIndex = publishStep.indexOf('git fetch origin main', pushIndex)
  const divergenceIndex = publishStep.indexOf(
    'git rev-list --left-right --count main...origin/main',
    fetchIndex,
  )
  const tagIndex = publishStep.indexOf('git tag -a v<version>', divergenceIndex)
  const releaseIndex = publishStep.indexOf('gh release create v<version>', tagIndex)

  assert.ok(mergeIndex >= 0, 'release worktree candidate must fast-forward local main')
  assert.ok(pushIndex > mergeIndex, 'local main must advance before origin/main is pushed')
  assert.ok(fetchIndex > pushIndex, 'origin/main must be fetched again after the push')
  assert.ok(divergenceIndex > fetchIndex, 'the workflow must prove divergence is 0 0')
  assert.ok(tagIndex > divergenceIndex, 'the tag must be created after branch convergence')
  assert.ok(releaseIndex > tagIndex, 'the GitHub release must be created from the synchronized tag')
})

test('release worktree direct pushes to main only appear as explicit prohibitions', () => {
  const directPushLines = skillText
    .split(/\r?\n/)
    .filter((line) => line.includes('git push origin HEAD:main'))

  assert.ok(directPushLines.length > 0, 'the dangerous command must be named explicitly')
  assert.ok(
    directPushLines.every((line) => /never|must never/i.test(line)),
    `every direct worktree push mention must prohibit it:\n${directPushLines.join('\n')}`,
  )
})

test('release pipeline runs the sensitive-content audit before versioning and again on the candidate', () => {
  const auditIndex = skillText.indexOf('pnpm release:audit -- --base origin/main --json')
  const versionIndex = skillText.indexOf('3. Set the final release version')
  const rerunIndex = skillText.indexOf('rerun `pnpm release:audit', versionIndex)
  assert.ok(auditIndex >= 0, 'skill must invoke the release safety audit')
  assert.ok(auditIndex < versionIndex, 'safety audit must precede version bump')
  assert.ok(rerunIndex > versionIndex, 'skill must audit again after version edit')
  assert.match(skillText, /does not inspect commit author\/committer emails/)
  assert.match(skillText, /--notes-file <notes-file>/)
  assert.doesNotMatch(skillText, /gh release create[^\n]* --notes <concise notes>/)
})

test('release zip workflow validates the tag and audits before dependency install', () => {
  const workflow = readFileSync('.github/workflows/release-zip.yml', 'utf8')
  const auditIndex = workflow.indexOf('node scripts/audit-release-safety.mjs')
  const installIndex = workflow.indexOf('pnpm install --frozen-lockfile')
  assert.ok(auditIndex >= 0)
  assert.ok(auditIndex < installIndex)
  assert.match(workflow, /\^v\\d\+\\\.\\d\+\\\.\\d\+\$/)
  assert.match(workflow, /RELEASE_TAG\^/)
})
