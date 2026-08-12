// probe-utility-process.js 的子进程侧。故意只用 CJS + process.parentPort，
// 保持和真实 utility host 相同的加载条件。
const report = (tag, extra = {}) => {
  process.parentPort.postMessage({
    tag,
    cwd: process.cwd(),
    electron: process.versions.electron ?? '(缺失)',
    dataDir: process.env.CHILL_VIBE_DATA_DIR ?? '(none)',
    moduleSystem: typeof require === 'function' ? 'CJS' : 'ESM',
    ...extra,
  })
}

process.parentPort.on('message', (event) => {
  if (event.data === 'probe') return report('as-forked')
  if (event.data && event.data.chdir) {
    try {
      process.chdir(event.data.chdir)
      report('after-chdir')
    } catch (error) {
      report('chdir-failed', { error: error.message })
    }
  }
})
