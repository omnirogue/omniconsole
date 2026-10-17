import { expect, it } from 'vitest'
import type { SessionPrepConnectorLaunch } from '../../shared/session-prep-connector'
import { planSessionPrepConnector } from './session-prep-connector-plan'

const launch: SessionPrepConnectorLaunch = {
  managedToolsFile: '/state/descriptor.json',
  nativeOperationId: '1791410000000-0123456789abcdef0123456789abcdef',
  resultsFolder: '/state/results',
  title: 'App task'
}
it.each([
  [
    'Use Claude Opus at high effort to fix the parser.',
    { agent: 'claude', model: 'opus', effort: 'high' }
  ],
  [
    'Use Codex GPT-6.1 Sol at low effort to fix the parser.',
    { agent: 'codex', model: 'gpt-6.1-sol', effort: 'low' }
  ],
  ['Research the options using Codex at xhigh.', { agent: 'codex', effort: 'xhigh' }],
  ['Write the launch announcement.', {}]
])('preserves explicit text choices: %s', (request, choices) => {
  const result = planSessionPrepConnector(request, launch)
  expect(result.items).toHaveLength(1)
  expect(result.items[0]).toMatchObject({ ask: request, anchor: request, direct: false, choices })
})
it('signed options take precedence over named text options', () => {
  expect(
    planSessionPrepConnector('Use Claude Opus with high effort.', {
      ...launch,
      provider: 'codex',
      model: 'gpt-6-astra',
      effort: 'low'
    }).items[0]?.choices
  ).toEqual({ agent: 'codex', model: 'gpt-6-astra', effort: 'low' })
})
it('refuses ambiguous model aliases instead of inventing a route', () => {
  expect(() => planSessionPrepConnector('Fix the parser using sol.', launch)).toThrow(
    'More than one model'
  )
})
