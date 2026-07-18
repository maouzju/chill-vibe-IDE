const bytesPerMb = 1024 * 1024
const kilobytesPerMb = 1024

type ProcessMemoryInput = Pick<
  NodeJS.MemoryUsage,
  'rss' | 'heapUsed' | 'external' | 'arrayBuffers'
>

type AppMetricInput = {
  memory?: {
    privateBytes?: number
    workingSetSize?: number
  }
}

const roundBytesToMb = (bytes: number) => Math.round(bytes / bytesPerMb)
const roundMetricKilobytesToMb = (kilobytes: number) => Math.round(kilobytes / kilobytesPerMb)

export const buildResourceHeartbeatSnapshot = ({
  processMemory,
  systemFreeBytes,
  systemTotalBytes,
  appMetrics,
}: {
  processMemory: ProcessMemoryInput
  systemFreeBytes: number
  systemTotalBytes: number
  appMetrics: AppMetricInput[]
}) => {
  const electronPrivateKilobytes = appMetrics.reduce(
    (total, metric) => total + (metric.memory?.privateBytes ?? 0),
    0,
  )
  const electronWorkingSetKilobytes = appMetrics.reduce(
    (total, metric) => total + (metric.memory?.workingSetSize ?? 0),
    0,
  )

  return {
    systemFreeMb: roundBytesToMb(systemFreeBytes),
    systemTotalMb: roundBytesToMb(systemTotalBytes),
    mainRssMb: roundBytesToMb(processMemory.rss),
    mainHeapUsedMb: roundBytesToMb(processMemory.heapUsed),
    mainExternalMb: roundBytesToMb(processMemory.external + processMemory.arrayBuffers),
    electronProcessCount: appMetrics.length,
    electronPrivateMb: roundMetricKilobytesToMb(electronPrivateKilobytes),
    electronWorkingSetMb: roundMetricKilobytesToMb(electronWorkingSetKilobytes),
  }
}

