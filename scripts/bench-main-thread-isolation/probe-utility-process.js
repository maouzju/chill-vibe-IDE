// utilityProcess 可行性探针 —— 后端进程隔离改造的第 0 天检查。
//
// 用法：pnpm exec electron scripts/bench-main-thread-isolation/probe-utility-process.js
//
// 症状：把后端搬进 utilityProcess 的方案里，有几件事「错了就得推翻方案」，而它们全都
//       不会报错，只会让子进程静默不响应或让数据写到别的目录。
// 根因：2026-08-12 实测，utilityProcess.fork 的 cwd 指向**不存在的目录**时，子进程
//       静默死亡 —— fork 不抛异常、没有 'exit' 事件、postMessage 石沉大海，什么线索
//       都没有。而 main.ts 里的工作目录来自配置/环境变量，完全可能指向一个已被删除
//       或尚未创建的路径。
// 为什么不能换写法：只能实测。类型签名说 cwd 是 string，没有任何地方提示路径不存在
//       会让进程无声消失而不是报错。所以 fork 前必须 existsSync 校验并兜底。
//
// 2026-08-12 实测结论（Electron 36.9.5）：
//   process.versions.electron 在 utility 里可见 = 36.9.5
//     -> server/archive-recall.ts 和 automation-board-session.ts 靠它决定要不要给 MCP
//        子进程设 ELECTRON_RUN_AS_NODE，这条不变，超管/archive-recall 安全。
//   env 默认继承主进程，也可以显式覆盖。
//   cwd 选项：**路径存在即可，正反斜杠都行**；路径不存在 = 静默失败。
//     （曾一度以为是反斜杠的锅并差点写进 ADR —— 那是 shell heredoc 吃掉一层转义
//       造成的假象：'D:\\Temp' 变成 'D:\Temp'，JS 再把 \T 解析掉得到不存在的
//       'D:Temp'。教训：验证脚本别用 heredoc 写，直接落文件。）
//   子进程内 process.chdir() 可用 —— 依然推荐用它对齐 main.ts 的
//   process.chdir(desktopWorkingDirectory)，因为它能在目标不存在时抛出可捕获的错误，
//   而不是像 fork 选项那样无声失败。server/app-paths.ts 的 getAppDataDir 有
//   process.cwd() 兜底，这里错了用户视角就是"历史全没了"。
const { app, BrowserWindow, utilityProcess } = require('electron')
const path = require('path')

const WORKER = path.join(__dirname, 'probe-utility-worker.js')
const EXISTING = process.env.TEMP ?? 'D:\\Temp'
const MISSING = path.join(EXISTING, 'no-such-dir-probe-xyz')

const attempt = (label, opts, thenChdirTo) => new Promise((resolve) => {
  let child
  try {
    child = opts ? utilityProcess.fork(WORKER, [], opts) : utilityProcess.fork(WORKER)
  } catch (error) {
    console.log(`${label}: FORK THREW -> ${error.message}`)
    return resolve(false)
  }
  const timer = setTimeout(() => {
    console.log(`${label}: TIMEOUT — 子进程没有任何回应（cwd 不存在时就是这个表现）`)
    try { child.kill() } catch {}
    resolve(false)
  }, 8000)
  child.on('message', (m) => {
    console.log(`${label} [${m.tag}]: cwd=${m.cwd}${m.error ? ` error=${m.error}` : ''}`)
    if (thenChdirTo && m.tag === 'as-forked') {
      child.postMessage({ chdir: thenChdirTo })
      return
    }
    clearTimeout(timer)
    try { child.kill() } catch {}
    resolve(true)
  })
  setTimeout(() => { try { child.postMessage('probe') } catch {} }, 600)
})

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  await win.loadURL('data:text/html,probe')

  console.log(`主进程 cwd = ${process.cwd()}`)
  console.log(`主进程 electron = ${process.versions.electron}`)
  console.log('')

  const existingOk = await attempt('cwd = 存在的目录', { cwd: EXISTING })
  const missingOk = await attempt('cwd = 不存在的目录', { cwd: MISSING })
  const chdirOk = await attempt('无 options + 子进程内 chdir', null, EXISTING)

  console.log('')
  console.log('--- 判定 ---')
  console.log(`  存在的 cwd 可用:           ${existingOk ? 'PASS' : 'FAIL'}`)
  console.log(`  不存在的 cwd 会静默失败:    ${missingOk ? 'FAIL(它居然起来了，结论要重写)' : 'PASS(符合预期：无声死亡)'}`)
  console.log(`  子进程内 chdir 可用:        ${chdirOk ? 'PASS(推荐用这条，失败会抛错)' : 'FAIL'}`)
  app.exit(0)
})
