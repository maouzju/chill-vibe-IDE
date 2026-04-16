import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'

import {
  resolveZipEntryName,
  WINDOWS_ZIP_ROOT_FOLDER_NAME,
} from '../scripts/manual-win-zip-packager.mjs'

describe('manual Windows zip packager', () => {
  test('places root files under the Chill Vibe IDE folder', () => {
    const sourceDir = path.win32.join('C:\\', 'build', 'win-unpacked')
    const filePath = path.win32.join(sourceDir, 'Chill Vibe.exe')

    assert.equal(
      resolveZipEntryName(sourceDir, filePath, WINDOWS_ZIP_ROOT_FOLDER_NAME),
      'Chill Vibe IDE/Chill Vibe.exe',
    )
  })

  test('normalizes nested files into forward-slash zip paths', () => {
    const sourceDir = path.win32.join('C:\\', 'build', 'win-unpacked')
    const filePath = path.win32.join(sourceDir, 'resources', 'app', 'package.json')

    assert.equal(
      resolveZipEntryName(sourceDir, filePath, WINDOWS_ZIP_ROOT_FOLDER_NAME),
      'Chill Vibe IDE/resources/app/package.json',
    )
  })
})
