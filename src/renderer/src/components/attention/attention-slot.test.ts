import { describe, expect, it } from 'vitest'
import {
  ATTENTION_CURRENT_SLOT_ID,
  ATTENTION_NEEDS_YOU_SLOT_ID,
  buildAttentionPortalDescriptors,
  clampAttentionCursor,
  resolveAttentionSlots
} from './attention-slot'
import {
  ATTENTION_FIXTURE_PANE_A,
  ATTENTION_FIXTURE_PANE_B,
  attentionFixturePane
} from './attention-test-fixtures'

const current = { worktreeId: 'w1', tabId: 'tab-a', paneKey: ATTENTION_FIXTURE_PANE_A }
const paneB = attentionFixturePane()
const paneC = attentionFixturePane({
  paneKey: 'tab-c:33333333-3333-4333-8333-333333333333',
  portalPaneKey: 'tab-c:33333333-3333-4333-8333-333333333333',
  tabId: 'tab-c',
  worktreeId: 'w3',
  title: 'Approve the migration'
})

describe('resolveAttentionSlots', () => {
  it('shows the oldest waiting pane and hides the pane already on the left', () => {
    const currentAsAttention = attentionFixturePane({
      paneKey: ATTENTION_FIXTURE_PANE_A,
      portalPaneKey: ATTENTION_FIXTURE_PANE_A,
      tabId: 'tab-a',
      worktreeId: 'w1'
    })
    const slots = resolveAttentionSlots({
      current,
      attention: [currentAsAttention, paneB, paneC],
      heldPane: null,
      holdActive: false,
      selectedPaneKey: null
    })
    expect(slots.needsYou?.paneKey).toBe(ATTENTION_FIXTURE_PANE_B)
    expect(slots).toMatchObject({ index: 0, total: 2, held: false, sharesCurrentTab: false })
    expect(slots.candidates.map((pane) => pane.paneKey)).toEqual([
      ATTENTION_FIXTURE_PANE_B,
      paneC.paneKey
    ])
  })

  it('is blank when nothing needs the user', () => {
    const slots = resolveAttentionSlots({
      current,
      attention: [],
      heldPane: null,
      holdActive: false,
      selectedPaneKey: 'gone'
    })
    expect(slots).toEqual({
      needsYou: null,
      candidates: [],
      index: -1,
      total: 0,
      held: false,
      sharesCurrentTab: false
    })
  })

  it('honours an explicit pick while it still waits, even over the held pane', () => {
    const picked = resolveAttentionSlots({
      current,
      attention: [paneB, paneC],
      heldPane: paneB,
      holdActive: true,
      selectedPaneKey: paneC.paneKey
    })
    expect(picked.needsYou?.paneKey).toBe(paneC.paneKey)
    expect(picked.index).toBe(1)
    const stale = resolveAttentionSlots({
      current,
      attention: [paneB],
      heldPane: null,
      holdActive: false,
      selectedPaneKey: paneC.paneKey
    })
    expect(stale.needsYou?.paneKey).toBe(paneB.paneKey)
    expect(clampAttentionCursor(5, 2)).toBe(1)
    expect(clampAttentionCursor(-1, 2)).toBe(1)
  })

  it('keeps a cleared pane while the user is still in it, then releases it', () => {
    const held = resolveAttentionSlots({
      current,
      attention: [paneC],
      heldPane: paneB,
      holdActive: true,
      selectedPaneKey: null
    })
    expect(held.needsYou?.paneKey).toBe(paneB.paneKey)
    expect(held).toMatchObject({ held: true, index: -1, total: 1 })
    const released = resolveAttentionSlots({
      current,
      attention: [paneC],
      heldPane: paneB,
      holdActive: false,
      selectedPaneKey: null
    })
    expect(released.needsYou?.paneKey).toBe(paneC.paneKey)
    expect(released.held).toBe(false)
  })

  it('flags a waiting pane that lives in the current tab', () => {
    const sibling = attentionFixturePane({
      paneKey: 'tab-a:44444444-4444-4444-8444-444444444444',
      portalPaneKey: 'tab-a:44444444-4444-4444-8444-444444444444',
      tabId: 'tab-a',
      worktreeId: 'w1'
    })
    const slots = resolveAttentionSlots({
      current,
      attention: [sibling],
      heldPane: null,
      holdActive: false,
      selectedPaneKey: null
    })
    expect(slots.sharesCurrentTab).toBe(true)
    const wholeTab = resolveAttentionSlots({
      current: { ...current, paneKey: '' },
      attention: [sibling],
      heldPane: null,
      holdActive: false,
      selectedPaneKey: null
    })
    expect(wholeTab.needsYou).toBeNull()
  })
})

describe('buildAttentionPortalDescriptors', () => {
  const currentTarget = {} as HTMLElement
  const needsYouTarget = {} as HTMLElement

  it('publishes one descriptor per slot with focus following the focused slot', () => {
    const descriptors = buildAttentionPortalDescriptors({
      current,
      currentTarget,
      needsYou: paneB,
      needsYouTarget,
      sharesCurrentTab: false,
      focusedSlot: 'needs-you'
    })
    expect(descriptors).toEqual([
      expect.objectContaining({
        slotId: ATTENTION_CURRENT_SLOT_ID,
        worktreeId: 'w1',
        tabId: 'tab-a',
        paneKey: ATTENTION_FIXTURE_PANE_A,
        active: false
      }),
      expect.objectContaining({
        slotId: ATTENTION_NEEDS_YOU_SLOT_ID,
        worktreeId: 'w2',
        tabId: 'tab-b',
        paneKey: ATTENTION_FIXTURE_PANE_B,
        active: true
      })
    ])
  })

  it('shows the whole current tab when the waiting pane shares it', () => {
    const descriptors = buildAttentionPortalDescriptors({
      current,
      currentTarget,
      needsYou: attentionFixturePane({ tabId: 'tab-a', worktreeId: 'w1' }),
      needsYouTarget,
      sharesCurrentTab: true,
      focusedSlot: 'needs-you'
    })
    expect(descriptors).toHaveLength(1)
    expect(descriptors[0]).toMatchObject({
      slotId: ATTENTION_CURRENT_SLOT_ID,
      paneKey: '',
      active: true
    })
  })

  it('skips slots without a target or a routable pane', () => {
    expect(
      buildAttentionPortalDescriptors({
        current,
        currentTarget: null,
        needsYou: attentionFixturePane({ portalPaneKey: null }),
        needsYouTarget,
        sharesCurrentTab: false,
        focusedSlot: 'current'
      })
    ).toEqual([])
  })
})
