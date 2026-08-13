import fs from 'node:fs'
import path from 'node:path'

const file = process.argv[2] ?? path.join(process.env.APPDATA, 'chill-vibe-ide', 'data', 'state.json')
const s = JSON.parse(fs.readFileSync(file, 'utf8'))

const collect = (node, out = []) => {
  if (!node) return out
  if (node.type === 'pane') out.push(...(node.tabs ?? []))
  else for (const child of node.children ?? []) collect(child.node ?? child, out)
  return out
}

for (const col of s.columns) {
  console.log('\n=== column', col.id, '|', col.title, '|', col.workspacePath)
  const tabs = collect(col.layout)
  const ids = Object.keys(col.cards ?? {})
  console.log('  cards', ids.length, '| layout tabs', tabs.length)
  for (const [id, c] of Object.entries(col.cards ?? {})) {
    const inTab = tabs.includes(id)
    console.log(`   ${inTab ? ' ' : '*'} ${id} ${c.model} msgs=${(c.messages ?? []).length} title=${JSON.stringify((c.title ?? '').slice(0, 24))}`)
  }
  const missing = tabs.filter((t) => !col.cards?.[t])
  if (missing.length) console.log('  !! tabs pointing at missing cards:', missing)
}

const target = 'f15903d3-3d99-4869-b978-e958c576620b'
const found = s.columns.some((c) => c.cards?.[target])
console.log('\nsupervisor instanceCardId present anywhere:', found)
