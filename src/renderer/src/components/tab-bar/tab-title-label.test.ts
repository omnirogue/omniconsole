import { describe, expect, it } from 'vitest'
import { sharedTitlePrefixLength, tabTitleLabel } from './tab-title-label'

const ADS = ['Advertising run 255', 'Advertising run 161', 'Advertising run 98']

describe('tabTitleLabel', () => {
  it('truncates from the middle when three or more tabs share a long prefix', () => {
    expect(tabTitleLabel(ADS, 'Advertising run 255', 12)).toBe('Adv…255')
    expect(tabTitleLabel(ADS, 'Advertising run 161', 12)).toBe('Adv…161')
    expect(tabTitleLabel(ADS, 'Advertising run 98', 12)).toBe('Adv…98')
  })

  it('collapses the family even when unrelated tabs sit in the same strip', () => {
    const titles = [...ADS, 'Terminal 1', 'Terminal 2', 'IDE repo']
    expect(tabTitleLabel(titles, 'Advertising run 161', 12)).toBe('Adv…161')
    // Why: "Terminal N" shares only "Terminal " (9 chars) across two tabs — below the
    // three-tab floor, so it keeps end truncation.
    expect(tabTitleLabel(titles, 'Terminal 1', 12)).toBe('Terminal 1')
  })

  it('keeps end truncation for a lone tab', () => {
    expect(tabTitleLabel(['Advertising run 255'], 'Advertising run 255', 12)).toBe('Advertising…')
    expect(tabTitleLabel(['Advertising run 255'], 'Advertising run 255', 40)).toBe(
      'Advertising run 255'
    )
  })

  it('keeps end truncation when only two tabs share the prefix', () => {
    const titles = ['Advertising run 255', 'Advertising run 161', 'Terminal 1']
    expect(tabTitleLabel(titles, 'Advertising run 255', 12)).toBe('Advertising…')
  })

  it('keeps end truncation when the shared prefix is shorter than eight characters', () => {
    const titles = ['Run 255', 'Run 161', 'Run 98']
    expect(sharedTitlePrefixLength(titles, 'Run 255')).toBe(0)
    expect(tabTitleLabel(titles, 'Run 255', 12)).toBe('Run 255')
  })

  it('leaves short titles untouched', () => {
    expect(tabTitleLabel(['a', 'b', 'c'], 'a', 12)).toBe('a')
    expect(tabTitleLabel([], 'Chat', 12)).toBe('Chat')
  })

  it('does not collapse a short-titled family such as plain terminals', () => {
    // Why: "Terminal " is a 9-char shared prefix, but "Terminal 3" fits a tab whole;
    // end truncation still shows the digit, so "Ter…3" would only lose text.
    const titles = ['Terminal 1', 'Terminal 2', 'Terminal 3']
    expect(tabTitleLabel(titles, 'Terminal 3', 24)).toBe('Terminal 3')
    expect(tabTitleLabel(titles, 'Terminal 3', 8)).toBe('Termina…')
  })

  it('backs the prefix off to a word boundary so single-digit tails do not appear', () => {
    const titles = ['Advertising run 161', 'Advertising run 165', 'Advertising run 169']
    expect(sharedTitlePrefixLength(titles, 'Advertising run 161')).toBe('Advertising run '.length)
    expect(tabTitleLabel(titles, 'Advertising run 165', 12)).toBe('Adv…165')
  })

  it('end-truncates a long tail inside the budget', () => {
    const titles = [
      'Advertising run 255 — retry after budget change',
      'Advertising run 161 — second pass',
      'Advertising run 98'
    ]
    expect(tabTitleLabel(titles, 'Advertising run 255 — retry after budget change', 12)).toBe(
      'Adv…255 — r…'
    )
  })

  it('keeps the last word as the tail when a title is a bare prefix of its siblings', () => {
    // Why: the word-boundary retreat makes the shared prefix "Advertising ", so the
    // bare title still gets a tail ("run") that tells it apart from "…161"/"…98".
    const titles = ['Advertising run', 'Advertising run 161', 'Advertising run 98']
    expect(tabTitleLabel(titles, 'Advertising run', 12)).toBe('Adv…run')
  })

  it('does not count a duplicate of the same title twice', () => {
    const titles = ['Advertising run 255', 'Advertising run 255', 'Terminal 1']
    expect(tabTitleLabel(titles, 'Advertising run 255', 12)).toBe('Advertising…')
  })

  it('end-truncates a workflow title even when its siblings share its prefix', () => {
    // Why: live acceptance showed three Build + Review drafts as "Bui…Review", and three
    // prefilled objectives as "Fix…src/reserve.ts"; a workflow title reads from its start.
    const drafts = ['Build + Review', 'Build + Review', 'Build + Review']
    expect(tabTitleLabel(drafts, 'Build + Review', 24)).toBe('Bui…Review')
    expect(tabTitleLabel(drafts, 'Build + Review', 24, 'end')).toBe('Build + Review')
    const fixes = [
      'Fix the off-by-one in src/reserve.ts',
      'Fix the off-by-one in src/reserve.ts',
      'Fix the off-by-one in src/reserve.ts'
    ]
    expect(tabTitleLabel(fixes, fixes[0], 24, 'end')).toBe('Fix the off-by-one in s…')
    expect(tabTitleLabel(ADS, 'Advertising run 255', 12, 'end')).toBe('Advertising…')
  })

  it('handles unicode without splitting code points', () => {
    const titles = ['🚀 Déploiement 255', '🚀 Déploiement 161', '🚀 Déploiement 98']
    expect(tabTitleLabel(titles, '🚀 Déploiement 255', 12)).toBe('🚀 D…255')
    expect(tabTitleLabel(['🚀🚀🚀🚀🚀🚀'], '🚀🚀🚀🚀🚀🚀', 4)).toBe('🚀🚀🚀…')
  })
})
