import { describe, expect, it } from 'vitest'
import type { JiraIssue } from '../../../../../shared/jira-types'
import { groupJiraBoardIssues, jiraBoardIssueIdentity } from './jira-board-columns'

function issue(status: string, overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: '10001',
    key: 'OMR-1',
    title: 'Deliver onboarding',
    siteId: 'connection-a',
    url: 'https://example.atlassian.net/browse/OMR-1',
    project: { id: '10001', key: 'OMR', name: 'OmniRogue' },
    issueType: { id: '10008', name: 'Task' },
    labels: [],
    status: { id: '1', name: status, categoryKey: 'done', categoryName: 'Done' },
    createdAt: '2026-09-19T12:00:00Z',
    updatedAt: '2026-09-19T12:00:00Z',
    ...overrides
  }
}

describe('Jira board projection', () => {
  it.each(['Backlog', 'Ready', 'In Progress', 'Waiting', 'Review', 'Done'] as const)(
    'recognizes the canonical %s status as well as existing workflow aliases',
    (status) => {
      const item = issue(status)
      expect(groupJiraBoardIssues([item]).get(status)).toEqual([item])
    }
  )
  it('preserves actual states when combining planning and delivery in one lane', () => {
    const planning = issue('Planning')
    const working = issue('In Progress', { id: '10002' })
    const columns = groupJiraBoardIssues([planning, working])
    expect(columns.get('In Progress')).toEqual([planning, working])
    expect(planning.status.name).toBe('Planning')
    expect(working.status.name).toBe('In Progress')
  })

  it('keeps cancelled and unfamiliar terminal states visible outside Done', () => {
    const cancelled = issue('Cancelled')
    const custom = issue('Declined', { id: '10002' })
    const delivered = issue('Done', { id: '10003' })
    const columns = groupJiraBoardIssues([cancelled, custom, delivered])
    expect(columns.get('Done')).toEqual([delivered])
    expect(columns.get('Other statuses')).toEqual([cancelled, custom])
    expect([...columns.values()].flat()).toHaveLength(3)
  })

  it('does not conflate identical issue IDs on different Jira connections', () => {
    const first = issue('Proposed')
    const second = issue('Proposed', { siteId: 'connection-b' })
    expect(jiraBoardIssueIdentity(first)).not.toBe(jiraBoardIssueIdentity(second))
    expect(groupJiraBoardIssues([first, second]).get('Backlog')).toHaveLength(2)
  })
})
