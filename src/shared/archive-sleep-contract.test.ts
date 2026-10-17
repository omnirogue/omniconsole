import { describe, expect, it } from 'vitest'
import {
  ArchiveSleepNoteParamsSchema,
  ArchiveSleepReadingParamsSchema,
  isOpenAskText
} from './archive-sleep-contract'

describe('an open ask in the words of the last reply (G1)', () => {
  it('reads a reply that ends with a question, through trailing markdown', () => {
    expect(isOpenAskText('Tests pass. Should I open the PR?')).toBe(true)
    expect(isOpenAskText('Which branch should it target?**\n')).toBe(true)
    expect(isOpenAskText('Want me to merge it (yes/no)?')).toBe(true)
  })

  it('reads a numbered question list, as the 30 Sep session held three', () => {
    expect(isOpenAskText('Three decisions:\n1. Phase 0\n2. 30 minutes\n3. Archive pauses')).toBe(
      true
    )
    expect(isOpenAskText('  1. only one numbered line\nand prose')).toBe(false)
  })

  it('reads a plain report, an empty reply and none as no ask', () => {
    expect(isOpenAskText('Done: merged and deployed.')).toBe(false)
    expect(isOpenAskText('')).toBe(false)
    expect(isOpenAskText(null)).toBe(false)
    expect(isOpenAskText(undefined)).toBe(false)
  })
})

describe('the archive-sleep wire', () => {
  it('takes a reading target and a History note, and nothing else', () => {
    const target = { paneKey: 'tab:leaf', tabId: 'tab', worktreeId: 'wt' }
    expect(ArchiveSleepReadingParamsSchema.parse(target)).toEqual(target)
    expect(() => ArchiveSleepReadingParamsSchema.parse({ ...target, force: true })).toThrow()
    const note = {
      sessionKey: 'claude:abc',
      paneKey: 'tab:leaf',
      tabId: 'tab',
      title: 'Fix',
      via: 'cli',
      trigger: 'idle-timer',
      evidence: 'idle-timer: Done since …'
    }
    expect(ArchiveSleepNoteParamsSchema.parse(note)).toEqual(note)
    expect(() => ArchiveSleepNoteParamsSchema.parse({ ...note, via: 'agent' })).toThrow()
    expect(() => ArchiveSleepNoteParamsSchema.parse({ ...note, trigger: 'soon' })).toThrow()
  })
})
