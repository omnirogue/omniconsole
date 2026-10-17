import { expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from '../../../../../../shared/agent-session-option-catalog'
import { resolveLaunchPlan } from './resolve-launch-plan'

it('preserves a Muse model and effort on local and remote launches without a managed account', () => {
  for (const local of [true, false]) {
    expect(
      resolveLaunchPlan({
        hasTarget: true,
        local,
        capabilities: [
          {
            id: 'muse',
            label: 'Muse Code',
            status: 'usable',
            models: getAgentSessionOptionCatalog('muse')!.models
          }
        ],
        rows: { claude: [], codex: [] },
        pick: { agent: 'muse', model: 'muse-spark-1.3', effort: 'high' }
      })
    ).toEqual({
      kind: 'launch',
      agent: 'muse',
      launchPreferences: { model: 'muse-spark-1.3', effort: 'high' }
    })
  }
})
