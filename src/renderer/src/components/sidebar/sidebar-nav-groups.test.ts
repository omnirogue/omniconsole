import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { TopLevelView } from '../../../../shared/ui-chrome-types'
import en from '../../i18n/locales/en.json'
import {
  agentsGroupDefaultView,
  NAV_GROUPS,
  navGroup,
  navGroupForView,
  navGroupMemberViews
} from './sidebar-nav-groups'

const defaults = getDefaultSettings('/tmp')

describe('sidebar nav groups', () => {
  it('offers exactly the three primary destinations', () => {
    // Why: Conversations is the tab directly below Agents, not a destination above it.
    expect(NAV_GROUPS.map((group) => group.id)).toEqual(['work', 'companies', 'agents'])
  })

  it('derives the open group from the active view', () => {
    const expected: [TopLevelView, string | null][] = [
      ['work', 'work'],
      ['inbox', 'work'],
      ['attention', 'work'],
      ['grid', 'work'],
      ['tasks', 'work'],
      ['calendar', 'work'],
      ['companies', 'companies'],
      ['terminal', null],
      ['activity', 'agents'],
      ['skills', 'agents'],
      ['artifacts', 'agents'],
      ['office', 'agents'],
      ['buildReview', 'agents'],
      ['automations', 'agents'],
      ['mobile', 'agents'],
      ['localRuns', 'agents'],
      ['machines', 'agents'],
      ['space', null],
      ['settings', null]
    ]
    for (const [view, group] of expected) {
      expect([view, navGroupForView(view)]).toEqual([view, group])
    }
  })

  it('gives every top-level view a home except settings and the conversations themselves', () => {
    const grouped = new Set(NAV_GROUPS.flatMap((group) => group.views))
    // Why: a conversation (and a workspace's Space page reached from its pane) opens from the
    // Conversations tab below Agents, so no primary destination claims those views.
    for (const view of ['settings', 'terminal', 'space'] as TopLevelView[]) {
      expect(grouped.has(view)).toBe(false)
    }
    expect(grouped.size).toBe(19)
  })

  it('keeps the primary page out of its own member list', () => {
    expect(navGroupMemberViews('work')).toEqual([
      'project',
      'inbox',
      'attention',
      'grid',
      'tasks',
      'kanban',
      'calendar',
      'advertising'
    ])
    expect(navGroupMemberViews('companies')).toEqual([])
    expect(navGroupMemberViews('agents')).toEqual(navGroup('agents').views)
  })

  it('rejects an unknown group id', () => {
    expect(() => navGroup('nope' as never)).toThrow()
  })

  it('lands Agents on its first member that is still shown', () => {
    expect(agentsGroupDefaultView({ ...defaults, showSkillsButton: true })).toBe('skills')
    expect(
      agentsGroupDefaultView({ ...defaults, showSkillsButton: false, showArtifactsButton: true })
    ).toBe('artifacts')
    expect(agentsGroupDefaultView(defaults)).toBe('office')
    expect(agentsGroupDefaultView({ ...defaults, showOfficeButton: false })).toBe('buildReview')
  })

  it('falls back to Build + Review, which has no hide setting, when everything else is off', () => {
    expect(
      agentsGroupDefaultView({
        showSkillsButton: false,
        showArtifactsButton: false,
        showOfficeButton: false,
        showAutomationsButton: false,
        showMobileButton: false,
        experimentalActivity: false
      })
    ).toBe('buildReview')
  })

  it('still offers the default-on members while settings are loading', () => {
    expect(agentsGroupDefaultView(null)).toBe('office')
  })

  it('declares label and tooltip copy that the English catalog carries', () => {
    const catalog = en as unknown as Record<string, Record<string, string>>
    for (const group of NAV_GROUPS) {
      for (const key of [group.labelKey, group.tooltipKey]) {
        const [namespace, entry] = key.split('.')
        expect(catalog[namespace]?.[entry]).toBeTypeOf('string')
      }
    }
    expect(catalog.nav.workTooltip).toBe(
      'What needs you, what is happening, how your companies are doing.'
    )
  })
})
