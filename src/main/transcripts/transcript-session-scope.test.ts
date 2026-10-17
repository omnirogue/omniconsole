import { describe, expect, it } from 'vitest'
import { transcriptSessionScope } from './transcript-session-scope'

const home = '/Users/shona'

describe('transcriptSessionScope', () => {
  it('reads company and domain from ~/Work/<Company>/<Domain>/…', () => {
    expect(transcriptSessionScope('/Users/shona/Work/OmniRogue/Marketing/site', { home })).toEqual({
      company: 'OmniRogue',
      domain: 'Marketing'
    })
    expect(transcriptSessionScope('/Users/shona/Work/ApexLabs', { home })).toEqual({
      company: 'ApexLabs',
      domain: null
    })
  })

  it('answers null outside the work root rather than guessing', () => {
    expect(transcriptSessionScope('/Users/shona/Work', { home })).toEqual({
      company: null,
      domain: null
    })
    expect(transcriptSessionScope('/Users/shona/Repos/omni-ide', { home })).toEqual({
      company: null,
      domain: null
    })
    expect(transcriptSessionScope(null, { home })).toEqual({ company: null, domain: null })
  })

  it('honours a configured work root', () => {
    expect(transcriptSessionScope('/srv/work/Acme/Sales', { home, workRoot: '/srv/work' })).toEqual(
      { company: 'Acme', domain: 'Sales' }
    )
  })
})
