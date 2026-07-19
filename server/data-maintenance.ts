import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type DataMaintenancePhase = 'running' | 'complete' | 'degraded'

export type DataMaintenanceTaskState = {
  version: number
  phase: DataMaintenancePhase
  cursor?: string
  processed: number
  skipped: number
  total?: number
  updatedAt: string
  lastError?: string
}

export type DataMaintenanceLedger = {
  version: 1
  tasks: Record<string, DataMaintenanceTaskState>
}

export type DataMaintenanceSliceResult = {
  phase: DataMaintenancePhase
  cursor?: string
  processedDelta?: number
  skippedDelta?: number
  total?: number
  lastError?: string
  replaceProgress?: boolean
}

export type DataMaintenanceTask = {
  id: string
  version: number
  shouldRun?: (context: {
    dataDir: string
    previous?: DataMaintenanceTaskState
  }) => boolean | Promise<boolean>
  runSlice: (context: {
    dataDir: string
    previous?: DataMaintenanceTaskState
  }) => Promise<DataMaintenanceSliceResult>
}

const ledgerFileName = 'maintenance-state.json'
const activeRuns = new Map<string, Promise<DataMaintenanceLedger>>()

const emptyLedger = (): DataMaintenanceLedger => ({ version: 1, tasks: {} })

const normalizeTaskState = (value: unknown): DataMaintenanceTaskState | null => {
  if (!value || typeof value !== 'object') return null
  const state = value as Partial<DataMaintenanceTaskState>
  if (
    typeof state.version !== 'number' ||
    !['running', 'complete', 'degraded'].includes(state.phase ?? '') ||
    typeof state.processed !== 'number' ||
    typeof state.skipped !== 'number' ||
    typeof state.updatedAt !== 'string'
  ) {
    return null
  }

  return {
    version: Math.max(0, Math.trunc(state.version)),
    phase: state.phase as DataMaintenancePhase,
    cursor: typeof state.cursor === 'string' ? state.cursor : undefined,
    processed: Math.max(0, Math.trunc(state.processed)),
    skipped: Math.max(0, Math.trunc(state.skipped)),
    total: typeof state.total === 'number' ? Math.max(0, Math.trunc(state.total)) : undefined,
    updatedAt: state.updatedAt,
    lastError: typeof state.lastError === 'string' ? state.lastError : undefined,
  }
}

export const readDataMaintenanceLedger = async (dataDir: string): Promise<DataMaintenanceLedger> => {
  try {
    const parsed = JSON.parse(await readFile(path.join(dataDir, ledgerFileName), 'utf8')) as {
      version?: unknown
      tasks?: unknown
    }
    if (parsed.version !== 1 || !parsed.tasks || typeof parsed.tasks !== 'object') {
      return emptyLedger()
    }

    const tasks = Object.fromEntries(
      Object.entries(parsed.tasks as Record<string, unknown>).flatMap(([taskId, value]) => {
        const normalized = normalizeTaskState(value)
        return normalized ? [[taskId, normalized] as const] : []
      }),
    )
    return { version: 1, tasks }
  } catch {
    return emptyLedger()
  }
}

const writeDataMaintenanceLedger = async (dataDir: string, ledger: DataMaintenanceLedger) => {
  await mkdir(dataDir, { recursive: true })
  const target = path.join(dataDir, ledgerFileName)
  const temporary = `${target}.tmp`
  try {
    const content = `${JSON.stringify(ledger, null, 2)}\n`
    await writeFile(temporary, content, 'utf8')
    const validated = JSON.parse(await readFile(temporary, 'utf8')) as DataMaintenanceLedger
    if (validated.version !== 1 || !validated.tasks || typeof validated.tasks !== 'object') {
      throw new Error('Invalid maintenance ledger output')
    }
    await rename(temporary, target)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

const executeDataMaintenanceSlice = async (
  dataDir: string,
  tasks: DataMaintenanceTask[],
  now: () => Date,
): Promise<DataMaintenanceLedger> => {
  const ledger = await readDataMaintenanceLedger(dataDir)

  for (const task of tasks) {
    const stored = ledger.tasks[task.id]
    const previous = stored?.version === task.version ? stored : undefined
    let shouldRun = previous?.phase !== 'complete' && previous?.phase !== 'degraded'
    if (task.shouldRun) {
      try {
        shouldRun = await task.shouldRun({ dataDir, previous })
      } catch (error) {
        ledger.tasks[task.id] = {
          version: task.version,
          phase: 'degraded',
          processed: previous?.processed ?? 0,
          skipped: previous?.skipped ?? 0,
          total: previous?.total,
          cursor: previous?.cursor,
          updatedAt: now().toISOString(),
          lastError: errorMessage(error),
        }
        continue
      }
    }
    if (!shouldRun) continue

    try {
      const result = await task.runSlice({ dataDir, previous })
      const replace = result.replaceProgress === true
      ledger.tasks[task.id] = {
        version: task.version,
        phase: result.phase,
        cursor: result.cursor,
        processed: (replace ? 0 : previous?.processed ?? 0) + (result.processedDelta ?? 0),
        skipped: (replace ? 0 : previous?.skipped ?? 0) + (result.skippedDelta ?? 0),
        total: result.total ?? (replace ? undefined : previous?.total),
        updatedAt: now().toISOString(),
        lastError: result.lastError,
      }
    } catch (error) {
      ledger.tasks[task.id] = {
        version: task.version,
        phase: 'degraded',
        cursor: previous?.cursor,
        processed: previous?.processed ?? 0,
        skipped: previous?.skipped ?? 0,
        total: previous?.total,
        updatedAt: now().toISOString(),
        lastError: errorMessage(error),
      }
    }
  }

  try {
    await writeDataMaintenanceLedger(dataDir, ledger)
  } catch (error) {
    for (const task of tasks) {
      const state = ledger.tasks[task.id]
      if (state && state.phase === 'running') {
        ledger.tasks[task.id] = {
          ...state,
          phase: 'degraded',
          updatedAt: now().toISOString(),
          lastError: errorMessage(error),
        }
      }
    }
  }
  return ledger
}

export const runDataMaintenanceSlice = ({
  dataDir,
  tasks,
  now = () => new Date(),
}: {
  dataDir: string
  tasks: DataMaintenanceTask[]
  now?: () => Date
}): Promise<DataMaintenanceLedger> => {
  const key = path.resolve(dataDir).toLocaleLowerCase()
  const active = activeRuns.get(key)
  if (active) return active

  const run = executeDataMaintenanceSlice(dataDir, tasks, now).finally(() => {
    if (activeRuns.get(key) === run) activeRuns.delete(key)
  })
  activeRuns.set(key, run)
  return run
}

export const resetDataMaintenanceCoordinatorForTests = () => {
  activeRuns.clear()
}
