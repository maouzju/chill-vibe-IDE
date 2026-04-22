import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const defaultWindowsIconPath = path.join(projectRoot, 'build', 'icon.ico')

let toolingPromise

function compareSizeLabel(left, right) {
  const [leftWidth = 0, leftHeight = 0] = left.split('x').map((value) => Number.parseInt(value, 10))
  const [rightWidth = 0, rightHeight = 0] = right.split('x').map((value) => Number.parseInt(value, 10))

  if (leftWidth !== rightWidth) {
    return leftWidth - rightWidth
  }

  return leftHeight - rightHeight
}

function normalizeIconDimension(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value === 0) {
      return 256
    }

    if (value > 0) {
      return value
    }
  }

  return fallback
}

function summarizeIconItems(items) {
  const sizes = items
    .map((item) => {
      const width = normalizeIconDimension(item.width, item.data?.width ?? 0)
      const height = normalizeIconDimension(item.height, item.data?.height ?? 0)
      return `${width}x${height}`
    })
    .sort(compareSizeLabel)

  return {
    count: sizes.length,
    sizes,
  }
}

function resolvePnpmPackageEntry(packageName, entryRelativePath = 'dist/index.mjs') {
  const pnpmDir = path.join(projectRoot, 'node_modules', '.pnpm')
  const packagePrefix = `${packageName}@`
  const packageEntry = fs.readdirSync(pnpmDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(packagePrefix))
    .sort((left, right) => right.name.localeCompare(left.name))[0]

  if (!packageEntry) {
    throw new Error(`Unable to resolve ${packageName} from ${pnpmDir}`)
  }

  return path.join(pnpmDir, packageEntry.name, 'node_modules', ...packageName.split('/'), entryRelativePath)
}

async function loadWindowsExecutableTooling() {
  if (!toolingPromise) {
    toolingPromise = Promise.all([
      import(pathToFileURL(resolvePnpmPackageEntry('pe-library')).href),
      import(pathToFileURL(resolvePnpmPackageEntry('resedit')).href),
    ]).then(([PE, ResEdit]) => ({ PE, ResEdit }))
  }

  return toolingPromise
}

export async function readIconFileSummary(iconFilePath = defaultWindowsIconPath) {
  const { ResEdit } = await loadWindowsExecutableTooling()
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconFilePath))

  return {
    iconFilePath,
    ...summarizeIconItems(iconFile.icons),
  }
}

export async function readWindowsExecutableIconSummary(executablePath) {
  const { PE, ResEdit } = await loadWindowsExecutableTooling()
  const executable = PE.NtExecutable.from(fs.readFileSync(executablePath), { ignoreCert: true })
  const resources = PE.NtExecutableResource.from(executable)
  const iconGroups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries)

  return {
    executablePath,
    groups: iconGroups.map((group) => ({
      id: group.id,
      lang: group.lang,
      ...summarizeIconItems(group.icons),
    })),
  }
}

export async function patchWindowsExecutableIcon({
  executablePath,
  iconFilePath = defaultWindowsIconPath,
  defaultGroupId = 1,
  defaultLang = 1033,
}) {
  const { PE, ResEdit } = await loadWindowsExecutableTooling()
  const executable = PE.NtExecutable.from(fs.readFileSync(executablePath), { ignoreCert: true })
  const resources = PE.NtExecutableResource.from(executable)
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconFilePath))
  const existingGroup = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries)[0]
  const iconGroupId = existingGroup?.id ?? defaultGroupId
  const lang = existingGroup?.lang ?? defaultLang

  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    resources.entries,
    iconGroupId,
    lang,
    iconFile.icons.map((item) => item.data),
  )

  resources.outputResource(executable)
  fs.writeFileSync(executablePath, Buffer.from(executable.generate()))

  return {
    executablePath,
    iconFilePath,
    iconGroupId,
    lang,
    iconCount: iconFile.icons.length,
  }
}
