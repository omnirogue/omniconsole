import { describe, expect, it } from 'vitest'
import {
  automaticSessionCleanupKeep,
  normalizeAutomaticSessionCleanupProtection,
  type AutomaticSessionCleanupProtectionInput
} from './automatic-session-cleanup-protection'

const NOW = Date.parse('2026-10-02T12:00:00Z')
const CONFIG = {
  protectedWorkspacePaths: ['/work/Email Operations/'],
  protectedPaneKeys: ['email-pane'],
  protectStartedToday: true,
  timeZone: 'America/New_York'
}
const input = (): AutomaticSessionCleanupProtectionInput => ({
  config: CONFIG,
  target: {
    worktreePath: '/work/other',
    paneKey: 'pane',
    createdAt: Date.parse('2026-10-01T12:00:00Z')
  },
  facts: { routine: false, pinned: false, saved: false },
  now: NOW
})

describe('owner-local automatic cleanup protection', () => {
  it('allows only a fully known older unprotected target to reach the idle guards', () => {
    expect(automaticSessionCleanupKeep(input())).toBeNull()
  })

  it('keeps a session waiting on the person before any other rule, configured or not', () => {
    const waiting = { ...input().facts, answerWait: true }
    expect(automaticSessionCleanupKeep({ ...input(), facts: waiting })).toBe('awaiting-answer')
    expect(automaticSessionCleanupKeep({ ...input(), config: null, facts: waiting })).toBe(
      'awaiting-answer'
    )
    expect(
      automaticSessionCleanupKeep({ ...input(), facts: { ...input().facts, answerWait: false } })
    ).toBeNull()
  })

  it.each([
    undefined,
    null,
    {},
    { ...CONFIG, timeZone: 'not-a-time-zone' },
    { ...CONFIG, protectedWorkspacePaths: ['relative/path'] },
    { ...CONFIG, protectedWorkspacePaths: ['/work/email/../other'] },
    { ...CONFIG, protectedPaneKeys: [''] },
    { ...CONFIG, protectStartedToday: 'yes' }
  ])('keeps when protection is missing or malformed: %j', (config) => {
    expect(normalizeAutomaticSessionCleanupProtection(config)).toBeNull()
    expect(automaticSessionCleanupKeep({ ...input(), config })).toBe('protection-unconfigured')
  })

  it.each(['/work/Email Operations', '/work/Email Operations/worktrees/launch'])(
    'protects workspace subtree %s',
    (worktreePath) => {
      expect(
        automaticSessionCleanupKeep({ ...input(), target: { ...input().target, worktreePath } })
      ).toBe('protected-workspace')
    }
  )

  it('does not conflate a similarly named directory with a protected path', () => {
    expect(
      automaticSessionCleanupKeep({
        ...input(),
        target: { ...input().target, worktreePath: '/work/Email Operations-old' }
      })
    ).toBeNull()
  })

  it('matches Windows owner-local paths with separator and drive normalization', () => {
    expect(
      automaticSessionCleanupKeep({
        ...input(),
        config: { ...CONFIG, protectedWorkspacePaths: ['C:\\Work\\Email'] },
        target: { ...input().target, worktreePath: 'c:/work/email/child' }
      })
    ).toBe('protected-workspace')
  })

  it('protects exact pane identity', () => {
    expect(
      automaticSessionCleanupKeep({
        ...input(),
        target: { ...input().target, paneKey: 'email-pane' }
      })
    ).toBe('protected-session')
  })

  it.each(['routine', 'pinned', 'saved'] as const)(
    'protects %s and keeps unknown %s evidence',
    (field) => {
      expect(
        automaticSessionCleanupKeep({ ...input(), facts: { ...input().facts, [field]: true } })
      ).toBe(field)
      expect(
        automaticSessionCleanupKeep({ ...input(), facts: { ...input().facts, [field]: null } })
      ).toBe('protection-unknown')
    }
  )

  it.each([null, 0, Number.NaN, Infinity, NOW + 1])(
    'keeps unknown or future creation time %s',
    (createdAt) => {
      expect(
        automaticSessionCleanupKeep({ ...input(), target: { ...input().target, createdAt } })
      ).toBe('protection-unknown')
    }
  )

  it.each([null, 'relative', '/work/../other'])('keeps ambiguous workspace %s', (worktreePath) => {
    expect(
      automaticSessionCleanupKeep({ ...input(), target: { ...input().target, worktreePath } })
    ).toBe('protection-unknown')
  })

  it('uses the configured calendar day across UTC midnight and DST', () => {
    const at = (iso: string) =>
      automaticSessionCleanupKeep({
        ...input(),
        target: { ...input().target, createdAt: Date.parse(iso) }
      })
    expect(at('2026-10-02T03:59:59Z')).toBeNull()
    expect(at('2026-10-02T04:00:00Z')).toBe('started-today')
    expect(
      automaticSessionCleanupKeep({
        ...input(),
        now: Date.parse('2026-11-01T12:00:00Z'),
        target: { ...input().target, createdAt: Date.parse('2026-11-01T04:30:00Z') }
      })
    ).toBe('started-today')
  })

  it('can explicitly disable the calendar-day exception without accepting unknown age', () => {
    expect(
      automaticSessionCleanupKeep({
        ...input(),
        config: { ...CONFIG, protectStartedToday: false },
        target: { ...input().target, createdAt: NOW }
      })
    ).toBeNull()
  })
})
