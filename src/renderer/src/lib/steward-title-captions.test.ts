import { describe, expect, it } from 'vitest'
import type {
  OrganizationExecutor,
  OrganizationRecord
} from '../../../shared/session-organization-change'
import { stewardWasTitles } from './steward-title-captions'

const NOW = Date.parse('2026-09-26T12:00:00Z')
const STEWARD: OrganizationExecutor = { kind: 'app', feature: 'steward' }

function title(
  key: string,
  before: string,
  value: string,
  hoursAgo: number,
  executor: OrganizationExecutor = STEWARD
): OrganizationRecord {
  return {
    opId: `${key}-${hoursAgo}`,
    kind: 'title',
    targets: [{ sessionKey: key }],
    value,
    before: [before],
    executor,
    phase: 'applied',
    ts: new Date(NOW - hoursAgo * 60 * 60 * 1000).toISOString()
  }
}

describe('“was:” captions for steward re-titles', () => {
  it('shows the old title for a day, only while the steward’s title is the latest', () => {
    expect(
      stewardWasTitles(
        [
          title('a', 'Ship the toggle', 'New prototype', 2),
          // Newest first: the person renamed b after the steward did.
          title('b', 'New prototype', 'My name', 1, { kind: 'person', via: 'sidebar' }),
          title('b', 'Ship it', 'New prototype', 3),
          title('c', 'Old', 'Newer', 30)
        ],
        NOW
      )
    ).toEqual({ a: 'Ship the toggle' })
  })
})
