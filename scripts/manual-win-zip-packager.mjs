import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { patchWindowsExecutableIcon } from './windows-exe-icon.mjs'

const require = createRequire(import.meta.url)
export const WINDOWS_ZIP_ROOT_FOLDER_NAME = 'Chill Vibe IDE'
const windowsAbsolutePathPattern = /^[A-Za-z]:[\\/]/

const crcTable = new Uint32Array(256)

for (let index = 0; index < 256; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  crcTable[index] = value >>> 0
}

function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

function toDosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    Math.floor(date.getSeconds() / 2)
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f)

  return { dosDate, dosTime }
}

function walkFiles(rootDir) {
  const entries = []

  function visit(currentDir) {
    const children = fs.readdirSync(currentDir, { withFileTypes: true })

    for (const child of children) {
      const fullPath = path.join(currentDir, child.name)

      if (child.isDirectory()) {
        visit(fullPath)
        continue
      }

      if (child.isFile()) {
        entries.push(fullPath)
      }
    }
  }

  visit(rootDir)
  entries.sort((left, right) => left.localeCompare(right))
  return entries
}

function ensureCleanDirectory(targetDir) {
  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.mkdirSync(targetDir, { recursive: true })
}

function copyDirectory(sourceDir, targetDir) {
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true,
    dereference: true,
  })
}

function readJson(jsonPath) {
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
}

function writeJson(jsonPath, value) {
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true })
  fs.writeFileSync(jsonPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function sameDependencies(left = {}, right = {}) {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()

  if (leftKeys.length !== rightKeys.length) {
    return false
  }

  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
}

function findRuntimeSnapshot(projectRoot, dependencies) {
  const distDir = path.join(projectRoot, 'dist')
  const candidates = []

  function visit(currentDir, depth = 0) {
    if (!fs.existsSync(currentDir) || depth > 6) {
      return
    }

    const entries = fs.readdirSync(currentDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }

      const fullPath = path.join(currentDir, entry.name)

      if (entry.name === 'resources') {
        const appDir = path.join(fullPath, 'app')
        const appPackageJsonPath = path.join(appDir, 'package.json')
        const appNodeModulesDir = path.join(appDir, 'node_modules')

        if (fs.existsSync(appPackageJsonPath) && fs.existsSync(appNodeModulesDir)) {
          try {
            const appPackageJson = readJson(appPackageJsonPath)
            if (sameDependencies(appPackageJson.dependencies, dependencies)) {
              const stats = fs.statSync(appPackageJsonPath)
              candidates.push({
                appDir,
                nodeModulesDir: appNodeModulesDir,
                modifiedMs: stats.mtimeMs,
              })
            }
          } catch {
            // ignore malformed snapshots
          }
        }
      }

      visit(fullPath, depth + 1)
    }
  }

  visit(distDir)
  candidates.sort((left, right) => right.modifiedMs - left.modifiedMs)
  return candidates[0] ?? null
}

function createRuntimePackageJson(rootPackageJson) {
  return {
    name: rootPackageJson.name,
    description: rootPackageJson.description,
    license: rootPackageJson.license,
    version: rootPackageJson.version,
    type: rootPackageJson.type,
    main: rootPackageJson.main,
    engines: rootPackageJson.engines,
    repository: rootPackageJson.repository,
    homepage: rootPackageJson.homepage,
    bugs: rootPackageJson.bugs,
    author: rootPackageJson.author,
    dependencies: rootPackageJson.dependencies,
  }
}

function stageLegalFiles(projectRoot, winUnpackedDir) {
  const legalDir = path.join(winUnpackedDir, 'resources', 'legal')
  fs.mkdirSync(legalDir, { recursive: true })

  const files = [
    ['LICENSE', 'LICENSE.txt'],
    ['PRIVACY.md', 'PRIVACY.md'],
    ['SECURITY.md', 'SECURITY.md'],
    ['THIRD_PARTY.md', 'THIRD_PARTY.md'],
    ['THIRD_PARTY_LICENSES.md', 'THIRD_PARTY_LICENSES.md'],
  ]

  for (const [sourceName, targetName] of files) {
    const sourcePath = path.join(projectRoot, sourceName)
    if (!fs.existsSync(sourcePath)) {
      continue
    }

    fs.copyFileSync(sourcePath, path.join(legalDir, targetName))
  }
}

function stageRuntimeNodeModules(projectRoot, appDir, rootPackageJson) {
  const runtimeSnapshot = findRuntimeSnapshot(projectRoot, rootPackageJson.dependencies)

  if (!runtimeSnapshot) {
    throw new Error(
      'Unable to find a reusable packaged runtime node_modules snapshot with matching dependencies.',
    )
  }

  copyDirectory(runtimeSnapshot.nodeModulesDir, path.join(appDir, 'node_modules'))
}

function stageAppPayload(projectRoot, appDir, rootPackageJson) {
  writeJson(path.join(appDir, 'package.json'), createRuntimePackageJson(rootPackageJson))

  const buildSourceDir = path.join(projectRoot, 'build')
  const buildTargetDir = path.join(appDir, 'build')
  if (fs.existsSync(buildSourceDir)) {
    copyDirectory(buildSourceDir, buildTargetDir)
  }

  for (const segment of ['client', 'electron', 'server', 'shared']) {
    copyDirectory(path.join(projectRoot, 'dist', segment), path.join(appDir, 'dist', segment))
  }

  stageRuntimeNodeModules(projectRoot, appDir, rootPackageJson)
}

async function stageElectronShell(winUnpackedDir) {
  const electronBinaryPath = require('electron')
  const electronDistDir = path.dirname(electronBinaryPath)

  copyDirectory(electronDistDir, winUnpackedDir)

  const electronExePath = path.join(winUnpackedDir, 'electron.exe')
  const chillVibeExePath = path.join(winUnpackedDir, 'Chill Vibe.exe')
  if (fs.existsSync(chillVibeExePath)) {
    fs.rmSync(chillVibeExePath, { force: true })
  }
  fs.renameSync(electronExePath, chillVibeExePath)
  await patchWindowsExecutableIcon({ executablePath: chillVibeExePath })

  const licensePath = path.join(winUnpackedDir, 'LICENSE')
  if (fs.existsSync(licensePath)) {
    fs.renameSync(licensePath, path.join(winUnpackedDir, 'LICENSE.electron.txt'))
  }
}

export function resolveZipEntryName(
  sourceDir,
  filePath,
  rootEntryName = path.basename(sourceDir),
) {
  const relativePath =
    windowsAbsolutePathPattern.test(sourceDir) || windowsAbsolutePathPattern.test(filePath)
      ? path.win32.relative(sourceDir, filePath)
      : path.relative(sourceDir, filePath)

  return `${rootEntryName}/${relativePath.split(/[\\/]/).join('/')}`
}

export function writeZipFromDirectory(sourceDir, zipPath, rootEntryName = path.basename(sourceDir)) {
  const files = walkFiles(sourceDir)
  const zipFd = fs.openSync(zipPath, 'w')
  const centralDirectoryEntries = []
  let offset = 0

  try {
    for (const filePath of files) {
      const entryName = resolveZipEntryName(sourceDir, filePath, rootEntryName)
      const fileBuffer = fs.readFileSync(filePath)
      const compressedBuffer =
        fileBuffer.length > 0 ? zlib.deflateRawSync(fileBuffer, { level: 9 }) : Buffer.alloc(0)
      const fileStats = fs.statSync(filePath)
      const { dosDate, dosTime } = toDosDateTime(fileStats.mtime)
      const nameBuffer = Buffer.from(entryName)
      const crcValue = crc32(fileBuffer)

      const localHeader = Buffer.alloc(30)
      localHeader.writeUInt32LE(0x04034b50, 0)
      localHeader.writeUInt16LE(20, 4)
      localHeader.writeUInt16LE(0, 6)
      localHeader.writeUInt16LE(8, 8)
      localHeader.writeUInt16LE(dosTime, 10)
      localHeader.writeUInt16LE(dosDate, 12)
      localHeader.writeUInt32LE(crcValue, 14)
      localHeader.writeUInt32LE(compressedBuffer.length, 18)
      localHeader.writeUInt32LE(fileBuffer.length, 22)
      localHeader.writeUInt16LE(nameBuffer.length, 26)
      localHeader.writeUInt16LE(0, 28)

      fs.writeSync(zipFd, localHeader)
      fs.writeSync(zipFd, nameBuffer)
      fs.writeSync(zipFd, compressedBuffer)

      centralDirectoryEntries.push({
        crcValue,
        compressedSize: compressedBuffer.length,
        uncompressedSize: fileBuffer.length,
        dosDate,
        dosTime,
        nameBuffer,
        offset,
      })

      offset += localHeader.length + nameBuffer.length + compressedBuffer.length
    }

    const centralDirectoryOffset = offset

    for (const entry of centralDirectoryEntries) {
      const centralHeader = Buffer.alloc(46)
      centralHeader.writeUInt32LE(0x02014b50, 0)
      centralHeader.writeUInt16LE(20, 4)
      centralHeader.writeUInt16LE(20, 6)
      centralHeader.writeUInt16LE(0, 8)
      centralHeader.writeUInt16LE(8, 10)
      centralHeader.writeUInt16LE(entry.dosTime, 12)
      centralHeader.writeUInt16LE(entry.dosDate, 14)
      centralHeader.writeUInt32LE(entry.crcValue, 16)
      centralHeader.writeUInt32LE(entry.compressedSize, 20)
      centralHeader.writeUInt32LE(entry.uncompressedSize, 24)
      centralHeader.writeUInt16LE(entry.nameBuffer.length, 28)
      centralHeader.writeUInt16LE(0, 30)
      centralHeader.writeUInt16LE(0, 32)
      centralHeader.writeUInt16LE(0, 34)
      centralHeader.writeUInt16LE(0, 36)
      centralHeader.writeUInt32LE(0, 38)
      centralHeader.writeUInt32LE(entry.offset, 42)

      fs.writeSync(zipFd, centralHeader)
      fs.writeSync(zipFd, entry.nameBuffer)

      offset += centralHeader.length + entry.nameBuffer.length
    }

    const centralDirectorySize = offset - centralDirectoryOffset
    const endRecord = Buffer.alloc(22)
    endRecord.writeUInt32LE(0x06054b50, 0)
    endRecord.writeUInt16LE(0, 4)
    endRecord.writeUInt16LE(0, 6)
    endRecord.writeUInt16LE(centralDirectoryEntries.length, 8)
    endRecord.writeUInt16LE(centralDirectoryEntries.length, 10)
    endRecord.writeUInt32LE(centralDirectorySize, 12)
    endRecord.writeUInt32LE(centralDirectoryOffset, 16)
    endRecord.writeUInt16LE(0, 20)

    fs.writeSync(zipFd, endRecord)
  } finally {
    fs.closeSync(zipFd)
  }
}

export async function packageManualWindowsZip({
  projectRoot,
  outputDirAbsolute,
  version,
}) {
  const rootPackageJson = readJson(path.join(projectRoot, 'package.json'))
  const winUnpackedDir = path.join(outputDirAbsolute, 'win-unpacked')
  const appDir = path.join(winUnpackedDir, 'resources', 'app')
  const zipFileName = `Chill Vibe-${version}-win.zip`
  const zipPath = path.join(outputDirAbsolute, zipFileName)

  ensureCleanDirectory(outputDirAbsolute)
  await stageElectronShell(winUnpackedDir)
  stageAppPayload(projectRoot, appDir, rootPackageJson)
  stageLegalFiles(projectRoot, winUnpackedDir)
  writeZipFromDirectory(winUnpackedDir, zipPath, WINDOWS_ZIP_ROOT_FOLDER_NAME)

  return {
    zipPath,
    winUnpackedDir,
  }
}
