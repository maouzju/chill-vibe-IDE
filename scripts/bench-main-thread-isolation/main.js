// 验证地基：同样一批会阻塞的 git spawn，跑在主进程 vs 跑在 utilityProcess，
// 主线程事件循环延迟差多少。事件循环延迟就是窗口消息泵停摆的时长。
const { app, BrowserWindow, utilityProcess } = require('electron')
const { spawn } = require('child_process')
const path = require('path')

// bench 跑的就是本仓库自己，从脚本位置推导即可 —— 写死绝对路径会让这份基准在
// 别的 checkout（和别人的机器）上直接跑不起来。
const REPO = path.resolve(__dirname, '..', '..')
const N = 20

// 每 50ms 打一次心跳，记录实际间隔。间隔 - 50ms = 主线程被占住的时间。
let maxLagMs = 0
let lagSamples = []
let lastTick = Date.now()
const startLagMeter = () => setInterval(() => {
  const now = Date.now()
  const lag = now - lastTick - 50
  lastTick = now
  if (lag > 0) { lagSamples.push(lag); if (lag > maxLagMs) maxLagMs = lag }
}, 50)

const resetMeter = () => { maxLagMs = 0; lagSamples = []; lastTick = Date.now() }
const report = (label) => {
  // 只看「单次连续停摆」——Windows 判无响应看的就是这个，不是累计。
  const over1s = lagSamples.filter((x) => x >= 1000).length
  const over5s = lagSamples.filter((x) => x >= 5000).length
  console.log(`[${label}] 单次最长停摆=${maxLagMs}ms | 停摆>1s 次数=${over1s} | 停摆>5s 次数=${over5s} | 判定=${over5s > 0 ? '会被 Windows 当无响应杀掉' : '窗口全程可响应'}`)
}

const runGitInMain = () => new Promise((resolve) => {
  let done = 0
  const next = () => {
    if (done >= N) return resolve()
    done++
    const c = spawn('git', ['cat-file', '-s', 'HEAD:package.json'], { cwd: REPO, windowsHide: true })
    c.stdout.resume(); c.stderr.resume()
    c.on('close', next)
  }
  next()
})

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  await win.loadURL('data:text/html,probe')

  const timer = startLagMeter()

  console.log(`=== A: ${N} 次 git spawn 跑在【主进程】(现状) ===`)
  resetMeter()
  await runGitInMain()
  await new Promise((r) => setTimeout(r, 300))
  report('主进程内')

  console.log(`=== B: 同样 ${N} 次 git spawn 跑在【utilityProcess】(改造后) ===`)
  resetMeter()
  const child = utilityProcess.fork(path.join(__dirname, 'worker.js'))
  await new Promise((resolve) => {
    child.on('message', (m) => { if (m === 'done') resolve() })
    child.postMessage({ repo: REPO, n: N })
  })
  await new Promise((r) => setTimeout(r, 300))
  report('utilityProcess')

  clearInterval(timer)
  child.kill()
  app.quit()
})
