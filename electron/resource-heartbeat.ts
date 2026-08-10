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

type SystemMemoryInfoInput = {
  swapTotal?: number
  swapFree?: number
}

export type CommitPressure = 'normal' | 'high' | 'critical'

const highCommitPercent = 85
const criticalCommitPercent = 93

// 症状：08-06/08-09 三次整窗口闪退，事件日志无崩溃、无 minidump、main.log 无 process exit。
// 根因：系统提交内存顶满（实测 118.8/131.9 GB = 90%，22.6GB 是内核泄漏的访问令牌），
// 新提交失败使主进程被立即终止，连写 dump 都需要提交内存所以证据全灭；而当时心跳只有
// systemFreeMb，物理空闲还有 5-8GB，读起来完全正常。
// 为什么不能换写法：os.freemem() 只反映物理内存。Windows 上 GlobalMemoryStatusEx 的
// ullTotalPageFile/ullAvailPageFile 才是 commit limit 与剩余可提交量，Electron 经由
// process.getSystemMemoryInfo() 的 swapTotal/swapFree 暴露；Linux 同名字段是真 swap，
// 语义不同，故按 platform 门控，拿不到数据时宁可不报也不猜。
const buildCommitSnapshot = (
  platform: NodeJS.Platform | undefined,
  systemMemoryInfo: SystemMemoryInfoInput | undefined | null,
) => {
  if (platform !== 'win32' || !systemMemoryInfo) {
    return null
  }

  const limitKilobytes = systemMemoryInfo.swapTotal ?? 0
  const freeKilobytes = systemMemoryInfo.swapFree ?? 0
  if (limitKilobytes <= 0) {
    return null
  }

  const committedKilobytes = Math.max(0, limitKilobytes - freeKilobytes)
  const percent = Math.round((committedKilobytes / limitKilobytes) * 100)
  const pressure: CommitPressure =
    percent >= criticalCommitPercent ? 'critical' : percent >= highCommitPercent ? 'high' : 'normal'

  return {
    systemCommitLimitMb: roundMetricKilobytesToMb(limitKilobytes),
    systemCommittedMb: roundMetricKilobytesToMb(committedKilobytes),
    systemCommitPercent: percent,
    commitPressure: pressure,
  }
}

export const buildResourceHeartbeatSnapshot = ({
  processMemory,
  systemFreeBytes,
  systemTotalBytes,
  appMetrics,
  platform,
  systemMemoryInfo,
}: {
  processMemory: ProcessMemoryInput
  systemFreeBytes: number
  systemTotalBytes: number
  appMetrics: AppMetricInput[]
  platform?: NodeJS.Platform
  systemMemoryInfo?: SystemMemoryInfoInput | null
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
    ...buildCommitSnapshot(platform, systemMemoryInfo),
  }
}

