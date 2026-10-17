import { expect, it } from 'vitest'
import { lastActionLabel, sessionAgentLabel } from './last-action-label'
it.each([
  ['turn_end', 'Turn ended'],
  ['exit', 'Exited'],
  ['close', 'Closed'],
  ['quit', 'Quit'],
  ['abandoned', 'Abandoned']
])('labels stop %s without changing tool targets', (target, label) => {
  expect(lastActionLabel({ kind: 'stop', target })).toBe(label)
  expect(lastActionLabel({ kind: 'tool_call', target })).toBe(target)
})
it('preserves unknown action targets and empty actions', () => {
  expect(lastActionLabel({ kind: 'stop', target: 'future_reason' })).toBe('future_reason')
  expect(lastActionLabel(null)).toBe('')
})
it('uses the canonical catalog and known app labels with safe fallbacks', () => {
  expect(sessionAgentLabel('hub', 'other')).toBe('Hub · other agent')
  expect(sessionAgentLabel('claude', null)).toBe('Claude')
  expect(sessionAgentLabel('codex', 'new-model')).toBe('Codex · new-model')
  expect(sessionAgentLabel(undefined, '')).toBe('')
  expect(sessionAgentLabel('new-agent', undefined)).toBe('new-agent')
})
