import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import crypto from 'node:crypto'
import { inflateSync } from 'node:zlib'

import { getWindowIconPathForPlatform } from '../electron/window-options.ts'

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

type PngImage = {
  width: number
  height: number
  pixels: Uint8Array
}

const paethPredictor = (left: number, up: number, upLeft: number) => {
  const estimate = left + up - upLeft
  const leftDistance = Math.abs(estimate - left)
  const upDistance = Math.abs(estimate - up)
  const upLeftDistance = Math.abs(estimate - upLeft)

  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) {
    return left
  }

  if (upDistance <= upLeftDistance) {
    return up
  }

  return upLeft
}

const decodePng = async (filePath: string): Promise<PngImage> => {
  const data = await readFile(filePath)

  assert.equal(data.subarray(0, pngSignature.length).equals(pngSignature), true)

  let offset = pngSignature.length
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idatParts: Buffer[] = []

  while (offset < data.length) {
    const length = data.readUInt32BE(offset)
    offset += 4

    const type = data.subarray(offset, offset + 4).toString('ascii')
    offset += 4

    const chunk = data.subarray(offset, offset + length)
    offset += length + 4

    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0)
      height = chunk.readUInt32BE(4)
      bitDepth = chunk[8]
      colorType = chunk[9]
      continue
    }

    if (type === 'IDAT') {
      idatParts.push(chunk)
      continue
    }

    if (type === 'IEND') {
      break
    }
  }

  assert.equal(bitDepth, 8)
  assert.equal(colorType === 2 || colorType === 6, true)

  const bytesPerPixel = 4
  const sourceBytesPerPixel = colorType === 6 ? 4 : 3
  const sourceStride = width * sourceBytesPerPixel
  const inflated = inflateSync(Buffer.concat(idatParts))
  const pixels = new Uint8Array(width * height * bytesPerPixel)
  let previousRow = new Uint8Array(sourceStride)

  let sourceOffset = 0

  for (let y = 0; y < height; y += 1) {
    const filterType = inflated[sourceOffset]
    sourceOffset += 1

    const decodedRow = new Uint8Array(sourceStride)

    for (let x = 0; x < sourceStride; x += 1) {
      const raw = inflated[sourceOffset]
      sourceOffset += 1

      const left = x >= sourceBytesPerPixel ? decodedRow[x - sourceBytesPerPixel] : 0
      const up = previousRow[x] ?? 0
      const upLeft = x >= sourceBytesPerPixel ? previousRow[x - sourceBytesPerPixel] : 0

      if (filterType === 0) {
        decodedRow[x] = raw
      } else if (filterType === 1) {
        decodedRow[x] = (raw + left) & 255
      } else if (filterType === 2) {
        decodedRow[x] = (raw + up) & 255
      } else if (filterType === 3) {
        decodedRow[x] = (raw + Math.floor((left + up) / 2)) & 255
      } else if (filterType === 4) {
        decodedRow[x] = (raw + paethPredictor(left, up, upLeft)) & 255
      } else {
        throw new Error(`Unsupported PNG filter type: ${filterType}`)
      }
    }

    for (let x = 0; x < width; x += 1) {
      const sourceIndex = x * sourceBytesPerPixel
      const pixelIndex = (y * width + x) * bytesPerPixel

      pixels[pixelIndex] = decodedRow[sourceIndex]
      pixels[pixelIndex + 1] = decodedRow[sourceIndex + 1]
      pixels[pixelIndex + 2] = decodedRow[sourceIndex + 2]
      pixels[pixelIndex + 3] = colorType === 6 ? decodedRow[sourceIndex + 3] : 255
    }

    previousRow = decodedRow
  }

  return { width, height, pixels }
}

const readAlphaAt = (image: PngImage, x: number, y: number) =>
  image.pixels[(y * image.width + x) * 4 + 3]

const readPixelAt = (image: PngImage, x: number, y: number) => {
  const index = (y * image.width + x) * 4
  return {
    red: image.pixels[index],
    green: image.pixels[index + 1],
    blue: image.pixels[index + 2],
    alpha: image.pixels[index + 3],
  }
}

const hashFile = (filePath: string) =>
  crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')

type IconSummary = {
  count: number
  sizes: string[]
}

type WindowsExeIconModule = {
  readIconFileSummary(iconFilePath?: string): Promise<{ iconFilePath: string } & IconSummary>
  readWindowsExecutableIconSummary(executablePath: string): Promise<{
    executablePath: string
    groups: Array<IconSummary & { id: string | number; lang: string | number }>
  }>
  patchWindowsExecutableIcon(options: {
    executablePath: string
    iconFilePath?: string
    defaultGroupId?: number
    defaultLang?: number
  }): Promise<unknown>
}

const loadWindowsExeIconModule = (() => {
  const runtimeImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<WindowsExeIconModule>

  return () => runtimeImport('../scripts/windows-exe-icon.mjs')
})()

test('Electron icon asset keeps transparent corners', async () => {
  const image = await decodePng(path.join(process.cwd(), 'build', 'icon.png'))

  assert.equal(image.width > 0, true)
  assert.equal(image.height > 0, true)
  assert.equal(readAlphaAt(image, 0, 0), 0)
  assert.equal(readAlphaAt(image, 12, 12), 0)
})

test('development runtime keeps a separate app icon asset from packaged builds on Windows and Linux', () => {
  const projectRoot = process.cwd()

  assert.equal(
    getWindowIconPathForPlatform('win32', projectRoot, true),
    path.join(projectRoot, 'build', 'icon-dev.png'),
  )
  assert.equal(
    getWindowIconPathForPlatform('linux', projectRoot, true),
    path.join(projectRoot, 'build', 'icon-dev.png'),
  )
  assert.equal(
    getWindowIconPathForPlatform('win32', projectRoot, false),
    path.join(projectRoot, 'build', 'icon.png'),
  )
  assert.equal(
    getWindowIconPathForPlatform('darwin', projectRoot, true),
    undefined,
  )
})

test('development icon moon is red while the packaged icon stays the original neutral moon', async () => {
  const [packagedImage, devImage] = await Promise.all([
    decodePng(path.join(process.cwd(), 'build', 'icon.png')),
    decodePng(path.join(process.cwd(), 'build', 'icon-dev.png')),
  ])

  const packagedMoonPixel = readPixelAt(packagedImage, 150, 250)
  const devMoonPixel = readPixelAt(devImage, 150, 250)

  assert.equal(packagedMoonPixel.alpha, 255)
  assert.equal(devMoonPixel.alpha, 255)
  assert.equal(devMoonPixel.red > devMoonPixel.green + 30, true)
  assert.equal(devMoonPixel.red > devMoonPixel.blue + 60, true)
  assert.equal(Math.abs(packagedMoonPixel.red - packagedMoonPixel.green) < 20, true)
  assert.equal(Math.abs(packagedMoonPixel.green - packagedMoonPixel.blue) < 40, true)
})

test('packaging patch rewrites a copied electron executable to the packaged app icon set', {
  skip: process.platform !== 'win32',
}, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-vibe-exe-icon-'))
  const sourceExePath = path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
  const tempExePath = path.join(tempDir, 'Chill Vibe.exe')
  const iconFilePath = path.join(process.cwd(), 'build', 'icon.ico')

  fs.copyFileSync(sourceExePath, tempExePath)

  try {
    const {
      patchWindowsExecutableIcon,
      readIconFileSummary,
      readWindowsExecutableIconSummary,
    } = await loadWindowsExeIconModule()
    const expectedIcon = await readIconFileSummary(iconFilePath)
    const beforeHash = hashFile(tempExePath)

    await patchWindowsExecutableIcon({
      executablePath: tempExePath,
      iconFilePath,
    })

    const after = await readWindowsExecutableIconSummary(tempExePath)
    const afterHash = hashFile(tempExePath)

    assert.deepEqual(after.groups[0]?.sizes, expectedIcon.sizes)
    assert.equal(after.groups[0]?.count, expectedIcon.count)
    assert.notEqual(afterHash, beforeHash)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
