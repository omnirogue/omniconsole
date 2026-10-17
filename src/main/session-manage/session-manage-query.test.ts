import { describe, expect, it } from 'vitest'
import { sessionManageHostKey, sessionManageMatchesQuery } from '../../shared/session-manage-query'
import { manageEntry } from './session-manage-test-fixtures'
import { SessionManageListParams } from '../runtime/rpc/methods/session-manage-schemas'

describe('manager inventory scope', () => {
  it('rejects malformed host filters instead of widening to all machines', () => {
    for (const hostId of ['mw0002', 'ssh:', 'ssh:%bad', 'ssh:a|b', 'all']) {
      expect(SessionManageListParams.safeParse({ hostId }).success).toBe(false)
    }
    expect(sessionManageHostKey(null)).toBeNull()
    expect(SessionManageListParams.parse({ hostId: 'ssh:box/one' }).hostId).toBe('ssh:box%2Fone')
  })

  it('uses literal AND terms across metadata without treating them as a regular expression', () => {
    const entry = manageEntry({ title: 'Marketing [budget]', waitingOn: 'waiting for data' })
    expect(sessionManageMatchesQuery(entry, 'MARKETING data')).toBe(true)
    expect(sessionManageMatchesQuery(entry, '[budget]')).toBe(true)
    expect(sessionManageMatchesQuery(entry, '.*')).toBe(false)
    expect(sessionManageMatchesQuery(entry, 'Marketing other-project')).toBe(false)
  })
})
