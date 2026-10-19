import { describe, expect, it } from 'vitest'
import { attachTaskRowMatches } from './attach-task-search'

const row = {
  taskId: 'btk_85e6e24fe49e4a1f8202',
  title: 'Launch the scorecard drilldown',
  todo: {
    company_slug: 'apexlabs',
    next_action: 'Review the ads breakdown with Gamma'
  }
}

describe('attachTaskRowMatches', () => {
  it('matches everything when the query is blank', () => {
    expect(attachTaskRowMatches(row, '')).toBe(true)
    expect(attachTaskRowMatches(row, '   ')).toBe(true)
  })

  it('matches the title case-insensitively', () => {
    expect(attachTaskRowMatches(row, 'SCORECARD')).toBe(true)
    expect(attachTaskRowMatches(row, 'nonexistent')).toBe(false)
  })

  it('matches the full task id', () => {
    expect(attachTaskRowMatches(row, 'btk_85e6e24fe49e4a1f8202')).toBe(true)
    expect(attachTaskRowMatches(row, 'btk_85e6')).toBe(true)
  })

  it('matches the company slug', () => {
    expect(attachTaskRowMatches(row, 'apexlabs')).toBe(true)
  })

  it('matches a resolved company name whose words are not all in the slug', () => {
    expect(attachTaskRowMatches(row, 'ApexLabs Inc', { companyName: 'ApexLabs Inc' })).toBe(
      true
    )
    expect(attachTaskRowMatches(row, 'ApexLabs Inc', {})).toBe(false)
  })

  it('matches a resolved domain name', () => {
    expect(attachTaskRowMatches(row, 'advertising', { domainName: 'Advertising' })).toBe(true)
    expect(attachTaskRowMatches(row, 'engineering', { domainName: 'Advertising' })).toBe(false)
  })

  it('matches the next action', () => {
    expect(attachTaskRowMatches(row, 'Gamma')).toBe(true)
    expect(attachTaskRowMatches(row, 'breakdown')).toBe(true)
  })

  it('requires every word to match (AND), possibly across different fields', () => {
    expect(attachTaskRowMatches(row, 'scorecard apexlabs', {})).toBe(true)
    expect(attachTaskRowMatches(row, 'scorecard advertising', { domainName: 'Advertising' })).toBe(
      true
    )
    expect(attachTaskRowMatches(row, 'scorecard engineering', { domainName: 'Advertising' })).toBe(
      false
    )
  })

  it('is false when nothing matches', () => {
    expect(attachTaskRowMatches(row, 'whitelabel')).toBe(false)
  })
})
