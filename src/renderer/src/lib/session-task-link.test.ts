import { describe, expect, it } from 'vitest'
import { paneKeysForTask, parseSessionTaskLinks, setSessionTaskLink } from './session-task-link'

describe('session task links', () => {
  it('keeps the rows it understands and drops only the broken ones', () => {
    expect(
      parseSessionTaskLinks({
        'tab-1:leaf-1': { taskId: 'btk_1234abcd', sessionId: 'ses_abcd1234', title: 'Handoffs' },
        'tab-2:leaf-1': { taskId: 'not-a-task' },
        'tab-3:leaf-1': { taskId: 'btk_5678efgh' }
      })
    ).toEqual({
      'tab-1:leaf-1': { taskId: 'btk_1234abcd', sessionId: 'ses_abcd1234', title: 'Handoffs' },
      'tab-3:leaf-1': { taskId: 'btk_5678efgh' }
    })
    expect(parseSessionTaskLinks(null)).toEqual({})
    expect(parseSessionTaskLinks('nonsense')).toEqual({})
  })

  it('sets, replaces and clears one conversation link', () => {
    const one = setSessionTaskLink({}, 'tab-1:leaf-1', { taskId: 'btk_1234abcd' })
    expect(one).toEqual({ 'tab-1:leaf-1': { taskId: 'btk_1234abcd' } })
    const withSession = setSessionTaskLink(one, 'tab-1:leaf-1', {
      taskId: 'btk_1234abcd',
      sessionId: 'ses_abcd1234'
    })
    expect(withSession['tab-1:leaf-1']!.sessionId).toBe('ses_abcd1234')
    expect(setSessionTaskLink(withSession, 'tab-1:leaf-1', null)).toEqual({})
    expect(setSessionTaskLink(withSession, '   ', null)).toBe(withSession)
  })

  it('lists every conversation serving one task, which is how a task holds many', () => {
    const links = {
      'tab-1:leaf-1': { taskId: 'btk_1234abcd' },
      'tab-2:leaf-1': { taskId: 'btk_1234abcd' },
      'tab-3:leaf-1': { taskId: 'btk_5678efgh' }
    }
    expect(paneKeysForTask(links, 'btk_1234abcd')).toEqual(['tab-1:leaf-1', 'tab-2:leaf-1'])
    expect(paneKeysForTask(links, 'btk_0000zzzz')).toEqual([])
  })
})
