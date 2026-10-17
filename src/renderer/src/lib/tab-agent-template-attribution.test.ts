import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { keepLocalTabAgentTemplates } from './tab-agent-template-attribution'

const agentTemplate = { id: 'advertising', name: 'Advertising', digest: 'd30fc78b9495' }

function tab(id: string, extra: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: 'w',
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...extra
  }
}

describe('keepLocalTabAgentTemplates', () => {
  it('puts this desktop’s record back on the synced tab with the same id', () => {
    const synced = { w: [tab('t1'), tab('t2')] }
    const local = { w: [tab('t1', { agentTemplate })] }
    const kept = keepLocalTabAgentTemplates(synced, local)
    expect(kept.w?.[0]?.agentTemplate).toEqual(agentTemplate)
    expect(kept.w?.[1]).not.toHaveProperty('agentTemplate')
  })

  it('returns the synced tabs untouched when this desktop recorded nothing', () => {
    const synced = { w: [tab('t1')] }
    expect(keepLocalTabAgentTemplates(synced, { w: [tab('t1')] })).toBe(synced)
  })
})
