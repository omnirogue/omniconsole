import { describe, expect, it } from 'vitest'
import {
  findMergeHolds,
  readMergeWhenReadyBox,
  setMergeWhenReadyBox,
  titleWithoutMergeHold
} from './merge-when-ready-box'

const BOX =
  '- [ ] **Merge when ready** (Sal or Uma: tick to merge and deploy automatically once checks pass; untick to stop)'

describe('merge when ready box', () => {
  it('reads the box the estate job writes', () => {
    expect(readMergeWhenReadyBox(`${BOX}\n\n## Summary`)).toBe('unticked')
    expect(readMergeWhenReadyBox(`${BOX.replace('[ ]', '[x]')}\n\nbody`)).toBe('ticked')
    expect(readMergeWhenReadyBox(`${BOX.replace('[ ]', '[X]')}\n\nbody`)).toBe('ticked')
    expect(readMergeWhenReadyBox('## Summary\n- [ ] Merge when ready')).toBe('absent')
    expect(readMergeWhenReadyBox(null)).toBe('absent')
  })

  it('ticks and unticks only the box line', () => {
    const body = `${BOX}\n\n- [ ] unrelated task\n- [x] done task`
    const ticked = setMergeWhenReadyBox(body, true)
    expect(ticked).toBe(`${BOX.replace('[ ]', '[x]')}\n\n- [ ] unrelated task\n- [x] done task`)
    expect(setMergeWhenReadyBox(ticked ?? '', false)).toBe(body)
  })

  it('finds the box below other text', () => {
    const body = `Intro line\n${BOX}\nmore`
    expect(readMergeWhenReadyBox(body)).toBe('unticked')
    expect(setMergeWhenReadyBox(body, true)).toBe(`Intro line\n${BOX.replace('[ ]', '[x]')}\nmore`)
  })

  it('refuses to invent a box', () => {
    expect(setMergeWhenReadyBox('no box here', true)).toBeNull()
  })
})

describe('merge holds', () => {
  it('treats do-not-merge labels as holds in any spelling', () => {
    expect(findMergeHolds({ title: 'Fix', labels: ['needs-ai-fix', 'do-not-merge'] })).toEqual([
      { kind: 'label', label: 'do-not-merge' }
    ])
    expect(findMergeHolds({ title: 'Fix', labels: ['DO NOT MERGE'] })).toEqual([
      { kind: 'label', label: 'DO NOT MERGE' }
    ])
    expect(findMergeHolds({ title: 'Fix', labels: ['preview-off', 'merge-ready'] })).toEqual([])
  })

  it('treats a "do not merge" title as a hold', () => {
    expect(
      findMergeHolds({
        title: 'Paid buyers always get in (OmniRogue) - do not merge yet',
        labels: []
      })
    ).toEqual([{ kind: 'title', phrase: 'do not merge yet' }])
    expect(findMergeHolds({ title: 'Merge dashboards into one page', labels: [] })).toEqual([])
  })

  it('strips the title marker and its brackets', () => {
    expect(titleWithoutMergeHold('Paid buyers always get in (OmniRogue) - do not merge yet')).toBe(
      'Paid buyers always get in (OmniRogue)'
    )
    expect(titleWithoutMergeHold('[DO NOT MERGE] Fix refunds')).toBe('Fix refunds')
    expect(titleWithoutMergeHold('Fix refunds (do-not-merge)')).toBe('Fix refunds')
    expect(titleWithoutMergeHold('Fix refunds')).toBeNull()
    expect(titleWithoutMergeHold('[do not merge]')).toBeNull()
  })
})
