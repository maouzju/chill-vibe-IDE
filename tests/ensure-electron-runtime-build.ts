import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const electronArtifacts = [
  path.join(process.cwd(), 'dist', 'client', 'index.html'),
  path.join(process.cwd(), 'dist', 'electron', 'main.mjs'),
  path.join(process.cwd(), 'dist', 'electron', 'preload.cjs'),
]

let ensurePromise: Promise<void> | null = null

const hasElectronBuildArtifacts = async () => {
  try {
    await Promise.all(electronArtifacts.map((artifactPath) => access(artifactPath)))
    return true
  } catch {
    return false
  }
}

const runNodeScript = async (args: string[]) =>
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      windowsHide: true,
    })

    let stderr = ''
    let stdout = ''

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(stderr.trim() || stdout.trim() || `${args.join(' ')} failed with code ${code}`))
    })
  })

const buildElectronRuntime = async () => {
  await runNodeScript(['scripts/run-vite.mjs', 'build'])
  await runNodeScript(['scripts/build-electron.mjs'])
}

export const ensureElectronRuntimeBuild = async () => {
  if (await hasElectronBuildArtifacts()) {
    return
  }

  if (!ensurePromise) {
    ensurePromise = buildElectronRuntime().catch((error) => {
      ensurePromise = null
      throw error
    })
  }

  await ensurePromise
}

export const getElectronTestRendererUrl = () =>
  pathToFileURL(path.join(process.cwd(), 'dist', 'client', 'index.html')).toString()
