// Native-hang forensics.
//
// `collectJavaScriptCallStack()` answers "what JS is blocking the renderer" —
// and on this app's long-running freezes it keeps answering with an empty
// string, meaning the main thread is stuck OUTSIDE app JS (native call, GPU
// wait, GC, sync IO). That answer was logged as `available: false` and the
// investigation ended there every time, which is why the root cause has stayed
// undetermined across many reports.
//
// The only artifact that carries a native stack is a Crashpad minidump. The app
// already terminates the stuck renderer to recover it — that crash can produce
// exactly such a dump, but only if the crash reporter is running. This module
// is the pure decision core: classify the hang, name the directory where the
// native evidence lands, and separate a stuck renderer from a stuck GPU
// process. Keeping it Electron-free lets node:test exercise it directly.

import path from 'node:path'

export type BlockingClass = 'renderer-js' | 'native-or-gc'

export type UnresponsiveBlockingVerdict = {
  blockingClass: BlockingClass
  // Where the remaining evidence lives when there are no JS frames to read.
  // null when the JS stack itself is the evidence.
  nextEvidence: string | null
  actionable: boolean
}

// Turn "the JS stack was empty" from a dead end into a pointer at the native
// artifact that will be produced when the stuck renderer is terminated.
export const classifyUnresponsiveBlocking = (input: {
  jsStackAvailable: boolean
  crashDumpDirectory: string
}): UnresponsiveBlockingVerdict => {
  if (input.jsStackAvailable) {
    return { blockingClass: 'renderer-js', nextEvidence: null, actionable: true }
  }
  return {
    blockingClass: 'native-or-gc',
    nextEvidence: input.crashDumpDirectory,
    actionable: true,
  }
}

// Dumps sit beside the logs so a bug report only ever has to name one folder.
export const resolveCrashDumpDirectory = (dataDir: string): string =>
  path.join(dataDir, 'crash-dumps')

// A dump left over from an earlier freeze must never be read as today's root
// cause, so only entries that appeared across the forced crash are reported.
export const selectNewCrashDumps = (before: readonly string[], after: readonly string[]): string[] => {
  const seen = new Set(before)
  return after.filter((entry) => !seen.has(entry))
}

export type ChildProcessMetricLike = {
  pid: number
  type: string
  cpu?: { percentCPUUsage?: number }
}

export type ChildProcessMetricsSummary = {
  stuckRendererCpuPercent: number | null
  gpuProcessId: number | null
  gpuCpuPercent: number | null
  // A pinned GPU process means the block is below the renderer, so no renderer
  // side JS explanation can ever account for it.
  gpuAlsoSaturated: boolean
}

const saturatedCpuPercent = 80

export const summarizeChildProcessMetrics = (input: {
  rendererProcessId: number
  metrics: readonly ChildProcessMetricLike[]
}): ChildProcessMetricsSummary => {
  const renderer = input.metrics.find((entry) => entry.pid === input.rendererProcessId)
  const gpu = input.metrics.find((entry) => entry.type === 'GPU')
  const gpuCpuPercent = typeof gpu?.cpu?.percentCPUUsage === 'number' ? gpu.cpu.percentCPUUsage : null

  return {
    stuckRendererCpuPercent:
      typeof renderer?.cpu?.percentCPUUsage === 'number' ? renderer.cpu.percentCPUUsage : null,
    gpuProcessId: gpu?.pid ?? null,
    gpuCpuPercent,
    gpuAlsoSaturated: gpuCpuPercent !== null && gpuCpuPercent >= saturatedCpuPercent,
  }
}
