import { describe, expect, it } from 'vitest'
import {
  SESSION_REQUEST_MARKER,
  buildSessionRequestBody,
  parseSessionRequestBody,
  sessionHandoverMemo,
  sessionRequestTitle
} from './session-request'

describe('asking for somebody else’s session', () => {
  it('round-trips through the body a person also reads', () => {
    const request = {
      workspacePath: '/Users/maintainer/omni-ide-worktrees/my work',
      ledgerId: 'ldg_abc123',
      reason: 'I need the lander copy before the ads go out.',
      sessionLabel: 'Seedance lander'
    }

    const body = buildSessionRequestBody(request)

    expect(body.split('\n')[0]).toBe('I need the lander copy before the ads go out.')
    expect(body).toContain(SESSION_REQUEST_MARKER)
    expect(parseSessionRequestBody(body)).toEqual(request)
  })

  it('keeps a workspace path that contains spaces intact', () => {
    const body = buildSessionRequestBody({
      workspacePath: '/Users/maintainer/Work/OmniRogue/Marketing Campaigns/q4',
      reason: 'why',
      sessionLabel: 'Ad batch 12'
    })
    expect(parseSessionRequestBody(body)).toMatchObject({
      workspacePath: '/Users/maintainer/Work/OmniRogue/Marketing Campaigns/q4',
      sessionLabel: 'Ad batch 12'
    })
  })

  it('is not a request when the marker or the workspace is missing', () => {
    expect(parseSessionRequestBody('Please take a look at this.')).toBeNull()
    expect(parseSessionRequestBody(`${SESSION_REQUEST_MARKER} session=x`)).toBeNull()
  })

  it('names who asked, in the title the owner sees', () => {
    expect(sessionRequestTitle('Seedance lander', 'Uma')).toBe('Uma asked for: Seedance lander')
  })

  it('says what was handed over and why it was asked for', () => {
    expect(
      sessionHandoverMemo({
        sessionLabel: 'Seedance lander',
        reason: 'ads go out at noon',
        ownerName: 'Sal'
      })
    ).toBe(
      [
        'Sal handed over Seedance lander.',
        'You asked: ads go out at noon',
        'The work in progress is committed on the handoff branch below.'
      ].join('\n')
    )
  })
})
