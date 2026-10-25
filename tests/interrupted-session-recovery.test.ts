import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildInterruptedSessionResumePrompt,
  collectInterruptedAgents,
  getInterruptedSessionResumeRequest,
  hasInterruptedSessionRetryPayload,
  isInterruptedSessionRecoverable,
} from '../shared/interrupted-session-recovery.ts'

test('retry-last-user-message payloads stay recoverable without a session id', () => {
  const entry = {
    sessionId: undefined,
    resumeMode: 'retry-last-user-message' as const,
    resumePrompt: 'Retry the last step',
    resumeAttachments: [
      {
        id: 'image-1',
        fileName: 'repro.png',
        mimeType: 'image/png' as const,
        sizeBytes: 2048,
      },
    ],
  }

  assert.equal(hasInterruptedSessionRetryPayload(entry), true)
  assert.equal(isInterruptedSessionRecoverable(entry), true)
  assert.deepEqual(getInterruptedSessionResumeRequest(entry), {
    sessionId: undefined,
    prompt: 'Retry the last step',
    attachments: entry.resumeAttachments,
  })
})

test('empty retry payloads without a session id do not claim to be recoverable', () => {
  const entry = {
    sessionId: undefined,
    resumeMode: 'retry-last-user-message' as const,
    resumePrompt: '   ',
    resumeAttachments: [],
  }

  assert.equal(hasInterruptedSessionRetryPayload(entry), false)
  assert.equal(isInterruptedSessionRecoverable(entry), false)
  assert.equal(getInterruptedSessionResumeRequest(entry), null)
})

test('session resume requires a matching recorded model when the request model is known', () => {
  assert.deepEqual(
    getInterruptedSessionResumeRequest(
      {
        sessionId: 'claude-session-opus-48',
        sessionModel: 'claude-opus-4-8',
        resumeMode: 'resume',
        resumePrompt: '',
        resumeAttachments: [],
      },
      'claude-opus-4-8',
    ),
    {
      sessionId: 'claude-session-opus-48',
      prompt: '',
      attachments: [],
    },
  )

  assert.equal(
    getInterruptedSessionResumeRequest(
      {
        sessionId: 'legacy-session-without-model',
        sessionModel: undefined,
        resumeMode: 'resume',
        resumePrompt: '',
        resumeAttachments: [],
      },
      'claude-opus-4-8',
    ),
    null,
  )
})

test('session resume names sub-agents interrupted by IDE shutdown so the model reattaches them', () => {
  const agents = [{ threadId: 'agent-a', nickname: 'scout', message: 'reading files' }]
  const request = getInterruptedSessionResumeRequest({
    sessionId: 'session-1',
    sessionModel: 'claude-opus-5-5',
    resumeMode: 'resume',
    resumePrompt: '',
    resumeAttachments: [],
    provider: 'claude',
    interruptedAgents: agents,
  }, 'claude-opus-5-5')

  assert.equal(request?.sessionId, 'session-1')
  assert.match(request?.prompt ?? '', /agent-a/)
  assert.match(request?.prompt ?? '', /SendMessage/)
  assert.match(buildInterruptedSessionResumePrompt('codex', agents), /resume_agent/)
  assert.equal(buildInterruptedSessionResumePrompt('claude', []), '')
})

test('interrupted Claude Workflow runs resume through resumeFromRunId instead of SendMessage', () => {
  const messages = [{
    id: 'm1',
    role: 'assistant' as const,
    content: '',
    createdAt: new Date().toISOString(),
    meta: {
      kind: 'agents' as const,
      provider: 'claude' as const,
      structuredData: JSON.stringify({
        itemId: 'a', kind: 'agents', status: 'completed', view: 'status',
        agents: [
          { threadId: 'workflow:t1', role: 'Workflow', status: 'running', workflowRunId: 'wf_ab12cd34-ef5', workflowScriptPath: 'C:/s/x.js' },
          { threadId: 'workflow:t2', role: 'Workflow', status: 'completed', workflowRunId: 'wf_done00000-000' },
        ],
      }),
    },
  }]
  const agents = collectInterruptedAgents(messages)
  assert.deepEqual(agents, [
    { threadId: 'workflow:t1', role: 'Workflow', workflowRunId: 'wf_ab12cd34-ef5', workflowScriptPath: 'C:/s/x.js' },
  ])
  const prompt = buildInterruptedSessionResumePrompt('claude', agents)
  assert.match(prompt, /resumeFromRunId: "wf_ab12cd34-ef5"/)
  assert.match(prompt, /scriptPath: "C:\/s\/x\.js"/)
  assert.doesNotMatch(prompt, /wf_done/)
})
