const { spawn } = require('child_process')
process.parentPort.on('message', (e) => {
  const { repo, n } = e.data
  let done = 0
  const next = () => {
    if (done >= n) return process.parentPort.postMessage('done')
    done++
    const c = spawn('git', ['cat-file', '-s', 'HEAD:package.json'], { cwd: repo, windowsHide: true })
    c.stdout.resume(); c.stderr.resume()
    c.on('close', next)
  }
  next()
})
