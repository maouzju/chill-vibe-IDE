// Probe: which system:task_progress events does the Claude CLI send while a Workflow runs several agents in parallel?
//
// Why this script exists: on 2026-09-27 a user reported that a workflow was titled "four modules in parallel",
// yet the panel showed only one line. The journal showed the other three agents had already finished;
// the panel just never said so. Changing the panel to build lines from workflow_progress needs ground truth
// for these questions:
//   - how often workflow_progress is attached;
//   - which fields each workflow_agent entry carries (state / toolCalls / startedAt / lastToolName ...);
//   - whether the entries of agents that already finished are still in the list.
//
// Usage: node scripts/probe-claude-workflow-progress.mjs
// Output: a per-event summary on stdout; raw events go to a temporary directory whose path is printed at the end.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MODEL = process.env.PROBE_MODEL || 'sonnet'
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-workflow-progress-'))
const eventsPath = path.join(workDir, 'events.jsonl')
const t0 = Date.now()
const note = (line) => console.log(`[${String(Date.now() - t0).padStart(7, ' ')}ms] ${line}`)

// Workflow sub-agents refuse to run a sleep command that "has no purpose" (they end with 0 tool calls on the
// first try), so give them a normal small task instead: write files one step at a time. The number of steps
// sets the duration, which lets the 10-second throttled workflow_progress attachment show up.
const agentPrompt = (name, steps) =>
  `You are building a tiny fixture directory for a test. Using the Bash tool, create the files ${name}-1.txt through ${name}-${steps}.txt in the current directory, ONE Bash call per file (each file contains just its own number). After the last file, run one more Bash call that lists the ${name}-*.txt files. Then reply with the single word DONE.`

const script = `export const meta = { name: 'probe-progress', description: 'probe workflow progress events', phases: [{ title: 'Wave1' }] }
phase('Wave1')
const out = await parallel([
  () => agent(${JSON.stringify(agentPrompt('fast', 2))}, { label: 'A1:fast', phase: 'Wave1' }),
  () => agent(${JSON.stringify(agentPrompt('mid', 5))}, { label: 'A2:mid', phase: 'Wave1' }),
  () => agent(${JSON.stringify(agentPrompt('slow', 10))}, { label: 'A3:slow', phase: 'Wave1' }),
])
return out`

const prompt = `Run a workflow now: call the Workflow tool exactly once with this script (pass it verbatim as the "script" input), wait for it to finish, then reply with the single word FINISHED.\n\n${script}`

const child = spawn('claude',
  ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
    '--model', MODEL, '--dangerously-skip-permissions'],
  { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], shell: true })

child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n')

let workflowTaskId
let progressCount = 0
let withListCount = 0
const fieldSets = new Set()
let finished = false
const finish = (why) => {
  if (finished) return
  finished = true
  note(`DONE (${why}): task_progress=${progressCount} withWorkflowProgress=${withListCount}`)
  note(`workflow_agent field sets seen: ${JSON.stringify([...fieldSets])}`)
  note(`raw events: ${eventsPath}`)
  try { child.stdin.end() } catch { /* already closed */ }
  try { child.kill() } catch { /* already gone */ }
  setTimeout(() => process.exit(0), 500)
}

let buf = ''
child.stdout.on('data', (chunk) => {
  buf += chunk.toString()
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    fs.appendFileSync(eventsPath, line + '\n')
    let evt
    try { evt = JSON.parse(line) } catch { continue }
    if (evt.type === 'system' && typeof evt.subtype === 'string' && evt.subtype.startsWith('task_')) {
      if (evt.subtype !== 'task_progress') {
        const status = evt.status ?? evt.patch?.status ?? ''
        note(`${evt.subtype} id=${evt.task_id} type=${evt.task_type ?? ''} status=${status} desc=${evt.description ?? ''}`)
        if (evt.subtype === 'task_started' && evt.task_type === 'local_workflow') workflowTaskId = evt.task_id
        // The Workflow runs in the background and the root turn's result arrives before it finishes, so wait for
        // the workflow's own terminal state. The root model may also start local_bash tasks; their end is not the signal.
        const isWorkflow = evt.task_id === workflowTaskId
        if (isWorkflow && (evt.subtype === 'task_notification' || (evt.subtype === 'task_updated' && status && status !== 'running'))) {
          setTimeout(() => finish(`workflow ${status}`), 3000)
        }
        continue
      }
      progressCount += 1
      const list = Array.isArray(evt.workflow_progress) ? evt.workflow_progress : undefined
      if (list) withListCount += 1
      const agents = (list ?? []).filter((entry) => entry?.type === 'workflow_agent')
      for (const entry of agents) fieldSets.add(Object.keys(entry).sort().join(','))
      const states = agents.map((entry) => `${entry.label}=${entry.state}/${entry.toolCalls ?? '-'}t`).join(' ')
      note(`progress desc="${evt.description}" last_tool="${evt.last_tool_name}" tools=${evt.usage?.tool_uses} ${list ? `LIST[${list.length}] ${states}` : ''}`)
    } else if (evt.type === 'result') {
      note(`result subtype=${evt.subtype} (root turn only; keep listening for the background workflow)`)
    }
  }
})
child.stderr.on('data', (d) => note(`STDERR ${d.toString().trim().slice(0, 200)}`))
child.on('exit', (code) => { note(`claude exited code=${code}`); finish('exit') })
setTimeout(() => finish('timeout'), 8 * 60_000)
