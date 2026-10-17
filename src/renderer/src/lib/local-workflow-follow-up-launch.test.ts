import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from '../../../shared/agent-session-option-catalog'
import type { LocalWorkflowSeatCatalog } from '../../../shared/local-workflow-seats'
import type { LocalWorkflowView } from '../../../shared/local-workflow-view'
import { planLocalWorkflowFollowUpLaunch } from './local-workflow-follow-up-launch'

const sonnet = getAgentSessionOptionCatalog('claude')!.models.find(
  (model) => model.id === 'sonnet'
)!
const catalog: LocalWorkflowSeatCatalog[] = [
  {
    agent: 'claude',
    accountId: 'system:claude',
    accountLabel: 'System Claude',
    accountHome: '/Users/maintainer/.claude',
    policyRevision: 'route-v1',
    models: [{ catalog: sonnet, resolvedModelId: 'claude-sonnet-5', lineage: 'anthropic' }]
  }
]
const view = {
  executionId: 'execution-1',
  fence: 1,
  sequence: 1,
  preset: 'council',
  state: 'completed',
  connection: 'connected',
  prompt: 'Inspect recovery',
  startedAt: 1,
  running: 0,
  queued: 0,
  reused: 0,
  actions: [],
  stages: [],
  calls: [],
  result: { markdown: 'Verified result', sources: [], coverage: [] },
  followUpSeat: {
    id: 'chair',
    agent: 'claude',
    accountId: 'system:claude',
    model: 'claude-sonnet-5',
    effort: 'high',
    lineage: 'anthropic',
    policyRevision: 'route-v1'
  }
} satisfies LocalWorkflowView

describe('workflow follow-up launch route', () => {
  it('maps the frozen resolved model to its launch alias and pins the system account', () => {
    expect(
      planLocalWorkflowFollowUpLaunch({
        view,
        catalog
      })
    ).toEqual({
      agent: 'claude',
      launchEnv: { CLAUDE_CONFIG_DIR: '/Users/maintainer/.claude' },
      launchPreferences: { model: 'sonnet', effort: 'high' }
    })
  })

  it('refuses a changed policy, missing account, or changed model before any session starts', () => {
    const input = { view, catalog }
    expect(() =>
      planLocalWorkflowFollowUpLaunch({
        ...input,
        catalog: [{ ...catalog[0], policyRevision: 'route-v2' }]
      })
    ).toThrow(/model or account has changed/)
    expect(() =>
      planLocalWorkflowFollowUpLaunch({
        ...input,
        view: {
          ...view,
          followUpSeat: { ...view.followUpSeat, accountId: 'profile:deleted' }
        }
      })
    ).toThrow(/model or account has changed/)
    expect(() =>
      planLocalWorkflowFollowUpLaunch({
        ...input,
        catalog: [
          {
            ...catalog[0],
            models: [{ ...catalog[0].models[0], resolvedModelId: 'claude-sonnet-6' }]
          }
        ]
      })
    ).toThrow(/synthesis model is no longer available/)
  })

  it('follows up on a run admitted under an earlier revision of the same route', () => {
    const upgraded = [
      { ...catalog[0], policyRevision: 'route-v2', priorPolicyRevisions: ['route-v1'] }
    ]
    expect(planLocalWorkflowFollowUpLaunch({ view, catalog: upgraded }).launchPreferences).toEqual({
      model: 'sonnet',
      effort: 'high'
    })
    expect(() =>
      planLocalWorkflowFollowUpLaunch({
        view,
        catalog: [{ ...upgraded[0], priorPolicyRevisions: ['route-v0'] }]
      })
    ).toThrow(/model or account has changed/)
  })

  it('uses the fresh host home for a named profile even when a renderer profile has drifted', () => {
    const hostCatalog = [
      { ...catalog[0], accountId: 'profile:chosen', accountHome: '/host/selected-claude' }
    ]
    const hostView: LocalWorkflowView = {
      ...view,
      followUpSeat: { ...view.followUpSeat, accountId: 'profile:chosen' }
    }
    // No renderer settings enter this API; a stale profile with the same ID cannot redirect it.
    expect(
      planLocalWorkflowFollowUpLaunch({ view: hostView, catalog: hostCatalog }).launchEnv
    ).toEqual({
      CLAUDE_CONFIG_DIR: '/host/selected-claude'
    })
    expect(() =>
      planLocalWorkflowFollowUpLaunch({
        view: hostView,
        catalog: [{ ...hostCatalog[0], accountHome: '' }]
      })
    ).toThrow(/host-verified workflow account home/)
  })

  it('pins Grok system home instead of inheriting a different normal-launch default', () => {
    const grok = getAgentSessionOptionCatalog('grok')!.models.find(
      (model) => model.id === 'grok-4.6'
    )!
    const grokView: LocalWorkflowView = {
      ...view,
      followUpSeat: {
        id: 'chair',
        agent: 'grok',
        accountId: 'system:grok',
        model: 'grok-4.6-build',
        effort: 'high',
        lineage: 'xai',
        policyRevision: 'grok-route-v1'
      }
    }
    expect(
      planLocalWorkflowFollowUpLaunch({
        view: grokView,
        catalog: [
          {
            agent: 'grok',
            accountId: 'system:grok',
            accountLabel: 'System Grok',
            accountHome: '/Users/maintainer/.grok-work',
            policyRevision: 'grok-route-v1',
            models: [{ catalog: grok, resolvedModelId: 'grok-4.6-build', lineage: 'xai' }]
          }
        ]
      }).launchEnv
    ).toEqual({ GROK_HOME: '/Users/maintainer/.grok-work' })
  })
})
