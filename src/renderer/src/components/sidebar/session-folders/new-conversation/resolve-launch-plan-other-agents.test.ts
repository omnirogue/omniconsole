import { describe, expect, it } from 'vitest'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import { isOtherLauncherAgent, resolveLaunchPlan } from './resolve-launch-plan'

const input = (status: Partial<Record<TuiAgent, string>>, otherAgent: TuiAgent) => ({
  hasTarget: true,
  local: true,
  defaultProvider: 'claude' as const,
  capabilities: (['claude', 'aider', 'goose', 'claude-agent-teams'] as const).map((id) => ({
    id,
    label: id,
    status: status[id] ?? 'usable',
    models: []
  })),
  rows: { claude: [], codex: [] },
  pick: { otherAgent }
})

describe('Other agents launches', () => {
  it('lists only CLIs outside the provider rows and the Teams variant', () => {
    expect(isOtherLauncherAgent('aider')).toBe(true)
    expect(isOtherLauncherAgent('claude')).toBe(false)
    expect(isOtherLauncherAgent('omp')).toBe(false)
    expect(isOtherLauncherAgent('claude-agent-teams')).toBe(false)
  })
  it('starts a usable other agent as is, without accounts or preferences', () => {
    expect(resolveLaunchPlan(input({}, 'aider'))).toEqual({ kind: 'launch', agent: 'aider' })
  })
  it('refuses one that is not usable instead of falling back to a provider', () => {
    expect(resolveLaunchPlan(input({ goose: 'cli-missing' }, 'goose'))).toEqual({
      kind: 'provider-unavailable'
    })
  })
  it('never lets the other-agent path start a provider row agent', () => {
    expect(resolveLaunchPlan(input({}, 'claude-agent-teams'))).toEqual({
      kind: 'provider-unavailable'
    })
  })
})
