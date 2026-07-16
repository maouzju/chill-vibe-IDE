const readline = require('node:readline')

const durationMs = Math.max(
  10_000,
  Number.parseInt(process.env.CHILL_VIBE_CHAT_STRESS_DURATION_MS || '300000', 10) + 15_000,
)
const activityIntervalMs = Math.max(
  50,
  Number.parseInt(process.env.CHILL_VIBE_CHAT_STRESS_ACTIVITY_INTERVAL_MS || '250', 10),
)
const deltaIntervalMs = Math.max(
  40,
  Number.parseInt(process.env.CHILL_VIBE_CHAT_STRESS_DELTA_INTERVAL_MS || '100', 10),
)
const activityItemSlots = Math.max(
  20,
  Number.parseInt(process.env.CHILL_VIBE_CHAT_STRESS_ACTIVITY_ITEM_SLOTS || '120', 10),
)

const reply = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

let started = false
let activityTimer = null
let deltaTimer = null
let finishTimer = null
let commandIndex = 0
let deltaIndex = 0
const threadId = `chat-stress-thread-${process.pid}`
const turnId = `chat-stress-turn-${process.pid}`
const assistantItemId = `chat-stress-assistant-${process.pid}`

const clearTimers = () => {
  if (activityTimer) clearInterval(activityTimer)
  if (deltaTimer) clearInterval(deltaTimer)
  if (finishTimer) clearTimeout(finishTimer)
  activityTimer = null
  deltaTimer = null
  finishTimer = null
}

const startStressStream = () => {
  if (started) return
  started = true

  activityTimer = setInterval(() => {
    commandIndex += 1
    // Keep a finite set of item identities and repeatedly update them. This
    // sustains the production event rate for long soaks without making the
    // persistence layer's existing 500-message retention policy the thing
    // under test. It also exercises in-progress -> completed updates on stable
    // keys, which is the risky streaming path.
    const itemSlot = ((commandIndex - 1) % activityItemSlots) + 1
    const itemId = `chat-stress-command-${process.pid}-${itemSlot}`
    const command = `node -e "console.log('live stress ${commandIndex}')"`

    reply({
      method: 'item/started',
      params: {
        item: {
          id: itemId,
          type: 'command_execution',
          command,
          aggregated_output: '',
          exit_code: null,
          status: 'in_progress',
        },
      },
    })
    reply({
      method: 'item/completed',
      params: {
        item: {
          id: itemId,
          type: 'command_execution',
          command,
          aggregated_output: commandIndex % 8 === 0 ? `live output ${'x'.repeat(180)}` : '',
          exit_code: 0,
          status: 'completed',
        },
      },
    })
  }, activityIntervalMs)

  deltaTimer = setInterval(() => {
    deltaIndex += 1
    reply({
      method: 'item/agentMessage/delta',
      params: {
        itemId: assistantItemId,
        delta: `stream-${process.pid}-${deltaIndex} `,
      },
    })
  }, deltaIntervalMs)

  finishTimer = setTimeout(() => {
    clearTimers()
    reply({
      method: 'item/completed',
      params: {
        item: {
          id: assistantItemId,
          type: 'agent_message',
          text: `Completed deterministic chat stress stream ${process.pid}.`,
        },
      },
    })
    reply({
      method: 'turn/completed',
      params: {
        turn: {
          id: turnId,
          status: 'completed',
        },
      },
    })
  }, durationMs)
}

const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

reader.on('line', (line) => {
  if (!line.trim()) return

  const request = JSON.parse(line)

  if (request.method === 'initialize' && request.id) {
    reply({ id: request.id, result: {} })
    return
  }

  if (request.method === 'thread/start' && request.id) {
    reply({
      id: request.id,
      result: {
        thread: {
          id: threadId,
          status: { type: 'active' },
        },
      },
    })
    return
  }

  if (request.method === 'thread/resume' && request.id) {
    reply({
      id: request.id,
      result: {
        thread: {
          id: request.params?.threadId || threadId,
          status: { type: 'active' },
        },
      },
    })
    return
  }

  if (request.method === 'turn/start' && request.id) {
    reply({
      id: request.id,
      result: {
        turn: {
          id: turnId,
          status: 'inProgress',
          items: [],
          error: null,
        },
      },
    })
    startStressStream()
  }
})

process.on('SIGTERM', () => {
  clearTimers()
  process.exit(0)
})

process.on('SIGINT', () => {
  clearTimers()
  process.exit(0)
})
