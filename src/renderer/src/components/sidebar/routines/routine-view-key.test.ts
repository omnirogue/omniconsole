import { describe, expect, it } from 'vitest'
import {
  isRoutineViewKey,
  parseRoutineViewKey,
  routineHiddenKey,
  routineViewKey
} from './routine-view-key'

describe('routineViewKey', () => {
  it('scopes a routine to its catalog authority', () => {
    expect(routineViewKey({ kind: 'local' }, { id: 'a1' })).toBe('routine:local:a1')
    expect(routineViewKey({ kind: 'environment', environmentId: 'env-9' }, { id: 'a1' })).toBe(
      'routine:environment:env-9:a1'
    )
  })

  it('parses both shapes back and rejects other keys', () => {
    expect(parseRoutineViewKey('routine:local:a1')).toEqual({ hostKey: 'local', automationId: 'a1' })
    expect(parseRoutineViewKey('routine:environment:env-9:a1')).toEqual({
      hostKey: 'environment:env-9',
      automationId: 'a1'
    })
    expect(parseRoutineViewKey('["local","structured","abc"]')).toBeNull()
    expect(parseRoutineViewKey('routine:')).toBeNull()
    expect(parseRoutineViewKey('routine:local:')).toBeNull()
  })

  it('tells routine keys apart from conversation keys for drop targets', () => {
    expect(isRoutineViewKey('routine:local:a1')).toBe(true)
    expect(isRoutineViewKey('session-1')).toBe(false)
  })

  it('namespaces the hidden entry the way conversation rows do', () => {
    expect(routineHiddenKey('routine:local:a1')).toBe('routine:routine:local:a1')
  })
})
