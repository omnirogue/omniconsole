import type * as NodeFs from 'node:fs'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const race = vi.hoisted(() => ({ onTempWrite: null as null | (() => void) }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      actual.writeFileSync(...args)
      if (String(args[0]).endsWith('.tmp')) {
        race.onTempWrite?.()
      }
    }
  }
})

const { keepClaudeDiffPanelClosed } = await import('./claude-diff-panel-preference')

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'claude-diff-race-'))
  mkdirSync(join(home, '.claude'))
})

afterEach(() => {
  race.onTempWrite = null
  rmSync(home, { recursive: true, force: true })
})

describe('keepClaudeDiffPanelClosed under a concurrent write', () => {
  it('keeps a change that lands after the read instead of replacing it', () => {
    const path = join(home, '.claude.json')
    writeFileSync(path, JSON.stringify({ keep: 1 }), { mode: 0o600 })
    race.onTempWrite = () => {
      writeFileSync(path, JSON.stringify({ keep: 1, projects: { '/new': {} } }), { mode: 0o600 })
      utimesSync(path, new Date(), new Date(Date.now() + 5_000))
    }
    expect(keepClaudeDiffPanelClosed(join(home, '.claude'), {}, home)).toBe(0)
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ keep: 1, projects: { '/new': {} } })
  })

  it('does not recreate a config deleted after the read', () => {
    const path = join(home, '.claude.json')
    writeFileSync(path, JSON.stringify({ keep: 1 }), { mode: 0o600 })
    race.onTempWrite = () => rmSync(path)
    expect(keepClaudeDiffPanelClosed(join(home, '.claude'), {}, home)).toBe(0)
    expect(() => readFileSync(path, 'utf-8')).toThrow()
  })
})
