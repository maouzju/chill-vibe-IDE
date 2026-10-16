import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const projectRoot = process.cwd()
const testsDir = path.join(projectRoot, 'tests')

test('Playwright serves the renderer on its own 127.0.0.1 port, never the dev server 5173', async () => {
  const [helperBody, configBody, viteBody] = await Promise.all([
    readFile(path.join(testsDir, 'playwright-app-url.ts'), 'utf8'),
    readFile(path.join(projectRoot, 'playwright.config.ts'), 'utf8'),
    readFile(path.join(projectRoot, 'vite.config.ts'), 'utf8'),
  ])

  const defaultPort = Number(/process\.env\.PW_PORT \?\? (\d+)/.exec(helperBody)?.[1])
  const devPort = Number(/port:\s*(\d+)/.exec(viteBody)?.[1])
  assert.ok(Number.isInteger(defaultPort) && defaultPort > 0)
  assert.equal(devPort, 5173)
  assert.notEqual(defaultPort, devPort)
  assert.match(helperBody, /`http:\/\/127\.0\.0\.1:\$\{playwrightPort\}`/)
  assert.match(configBody, /--port \$\{playwrightPort\} --strictPort/)
  assert.match(configBody, /url:\s*appUrl/)
})

test('no Playwright spec hardcodes the renderer origin', async () => {
  const specs = (await readdir(testsDir)).filter((name) => name.endsWith('.spec.ts'))
  assert.ok(specs.length > 0)

  const offenders: string[] = []
  for (const name of specs) {
    const body = await readFile(path.join(testsDir, name), 'utf8')
    if (/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+/.test(body)) {
      offenders.push(name)
    }
  }

  assert.deepEqual(offenders, [])
})
