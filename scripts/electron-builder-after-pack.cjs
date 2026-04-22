const path = require('node:path')

async function main(context) {
  const { patchWindowsExecutableIcon } = await import('./windows-exe-icon.mjs')

  if (context.electronPlatformName !== 'win32') {
    return
  }

  const executableName = context.packager?.appInfo?.productFilename
    ? `${context.packager.appInfo.productFilename}.exe`
    : 'Chill Vibe.exe'
  const executablePath = path.join(context.appOutDir, executableName)

  await patchWindowsExecutableIcon({ executablePath })
  console.log(`[after-pack] patched Windows app icon: ${executablePath}`)
}

module.exports = main
