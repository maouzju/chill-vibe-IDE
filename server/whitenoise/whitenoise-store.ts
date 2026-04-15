import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { getAppDataDir } from '../app-paths.js'

const STORE_FILE = 'whitenoise-scenes.json'

export type NoiseGeneratorType = string

export type NoiseLayer = {
  id: string
  label: string
  generator: NoiseGeneratorType
  volume: number
  url?: string
}

export type NoiseScene = {
  id: string
  title: string
  prompt: string
  layers: NoiseLayer[]
  createdAt: string
}

function getFilePath() {
  return path.join(getAppDataDir(), STORE_FILE)
}

function readJson(filePath: string): unknown {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(filePath: string, payload: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

export function readScenes(): NoiseScene[] {
  const raw = readJson(getFilePath())
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (item): item is NoiseScene =>
      !!item && typeof item === 'object' && typeof (item as NoiseScene).id === 'string',
  )
}

export function writeScenes(scenes: NoiseScene[]): void {
  writeJson(getFilePath(), scenes)
}

export function addScene(scene: NoiseScene): NoiseScene[] {
  const scenes = readScenes()
  scenes.unshift(scene)
  writeScenes(scenes)
  return scenes
}

export function removeScene(sceneId: string): NoiseScene[] {
  const scenes = readScenes().filter((s) => s.id !== sceneId)
  writeScenes(scenes)
  return scenes
}

export function createId(): string {
  return crypto.randomUUID()
}
