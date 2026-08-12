// 探针：utilityProcess.fork 能否加载**打包进 asar 的 ESM 模块**。
//
// 用法：pnpm exec electron scripts/bench-main-thread-isolation/probe-asar-esm.js
//       （自动挑 dist/release-* 里最新的一个包）
//
// 症状：后端进程隔离方案要新增 electron/utility-host.ts 作为 utilityProcess 入口。
//       开发模式能跑不代表打包后能跑 —— 这类问题只在用户装了新版本之后才暴露。
// 根因：dist/electron/package.json 是 {"type":"module"}（build-electron.mjs:177-181
//       写的），所以 utility host 会以 **ESM** 被加载，而它又在 asar 归档里面。
//       "asar 内 ESM 能否被 fork" 没有任何现成证据 —— 仓库里唯一的先例
//       electron/crash-relaunch-guard-main.mjs 是另起进程用 ELECTRON_RUN_AS_NODE 跑的，
//       绕开了这个问题，不能作为证据。
// 为什么不能换写法：只能拿真实打包产物实测。失败的话就得配 asarUnpack（当前
//       electron-builder 配置里一项都没有，shipped asar 实测 0 个 unpacked 条目），
//       而且 dist/electron/package.json 得跟着一起 unpack，属于要提前知道的事。
//
// 2026-08-12 实测结论（Electron 36.9.5，release-20260812-101200）：**PASS，无需 asarUnpack。**
//   asar 内真实模块      -> exit 0（加载成功）
//   asar 内不存在的模块   -> exit 1（失败有明确信号，所以上一条不是假阳性）
//   ESM-only 语法探针     -> import.meta.url 可用、typeof require === 'undefined'
//                           （确认 utility 确实跑在 ESM 模式，不是被降级成 CJS）
const { app, utilityProcess } = require('electron')
const fs = require('fs')
const path = require('path')

// 挑最新的包，有两个坑叠在一起：
//  1) 不能按名字排序 —— dist 下既有 release-<时间戳> 也有 release-<主题名>
//     （release-native-hang-forensics 之类），字母序会把主题名排到时间戳前面。
//  2) 不能对 app.asar 本身取 mtime —— **Electron 把 .asar 当目录挂载**，对它
//     statSync 拿到的是归档的虚拟 stat，实测排序结果和真实新旧不符（会选到前一天的包）。
// 所以对 release 目录（真实目录）取 mtime。结论看着都一样，但测错包 = 没验证到当前产物。
const findNewestAsar = () => {
  const distDir = path.resolve(__dirname, '../../dist')
  return fs.readdirSync(distDir)
    .filter((name) => name.startsWith('release-'))
    .map((name) => ({
      asar: path.join(distDir, name, 'win-unpacked/resources/app.asar'),
      mtimeMs: fs.statSync(path.join(distDir, name)).mtimeMs,
    }))
    .filter((entry) => fs.existsSync(entry.asar))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((entry) => entry.asar)[0] ?? null
}

const attempt = (label, target) => new Promise((resolve) => {
  let child
  try {
    child = utilityProcess.fork(target)
  } catch (error) {
    console.log(`${label}: FORK THREW -> ${error.message}`)
    return resolve('threw')
  }
  const timer = setTimeout(() => {
    // utilityProcess 加载完模块后会保持运行等消息，这本身就是加载成功的表现。
    console.log(`${label}: 保持运行（加载成功，模块顶层无副作用）`)
    try { child.kill() } catch {}
    resolve('alive')
  }, 5000)
  child.on('message', (m) => {
    clearTimeout(timer)
    console.log(`${label}: 收到消息 -> ${JSON.stringify(m)}`)
    try { child.kill() } catch {}
    resolve('message')
  })
  child.on('exit', (code) => {
    clearTimeout(timer)
    console.log(`${label}: 退出 code=${code}${code === 0 ? '（加载成功）' : '（加载失败）'}`)
    resolve(code === 0 ? 'exit0' : 'exit-nonzero')
  })
})

app.whenReady().then(async () => {
  const asar = findNewestAsar()
  if (!asar) {
    console.log('找不到打包产物（dist/release-*/win-unpacked/resources/app.asar），先跑 pnpm electron:build')
    return app.exit(1)
  }
  const electronDir = path.join(asar, 'dist/electron')
  console.log('asar:', asar)
  console.log('dist/electron/package.json =', fs.readFileSync(path.join(electronDir, 'package.json'), 'utf8').replace(/\s+/g, ' ').trim())

  const modules = fs.readdirSync(electronDir).filter((f) => f.endsWith('.js'))
  const target = modules.includes('accessibility-support.js') ? 'accessibility-support.js' : modules[0]
  console.log(`asar 内模块数 = ${modules.length}，用于测试: ${target}`)
  console.log('')

  // ESM-only 语法探针放在 asar 外：它证明的是"utility 跑的是 ESM 语义"，
  // 和"asar 内能否加载"是两个独立结论，合起来才完整。
  const esmProbe = path.join(app.getPath('temp'), 'chill-vibe-esm-probe.mjs')
  fs.writeFileSync(esmProbe, [
    'const url = import.meta.url',
    'process.parentPort.postMessage({ ok: true, esm: typeof require === "undefined", url })',
  ].join('\n'), 'utf8')

  const real = await attempt('A asar 内真实模块', path.join(electronDir, target))
  const missing = await attempt('B asar 内不存在的模块', path.join(electronDir, 'no-such-module-xyz.js'))
  const esm = await attempt('C ESM-only 语法探针', esmProbe)

  console.log('')
  console.log('--- 判定 ---')
  console.log(`  asar 内 ESM 可加载:        ${real === 'alive' || real === 'exit0' ? 'PASS -> 无需 asarUnpack' : 'FAIL -> 需要配 asarUnpack'}`)
  console.log(`  失败有明确信号(非假阳性):   ${missing === 'exit-nonzero' ? 'PASS' : 'FAIL(判据不可靠)'}`)
  console.log(`  utility 跑的是 ESM:        ${esm === 'message' ? 'PASS' : 'FAIL'}`)
  try { fs.unlinkSync(esmProbe) } catch {}
  app.exit(0)
})
