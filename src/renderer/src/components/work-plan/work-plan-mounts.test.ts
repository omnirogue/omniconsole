import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

const source = (file: string) => readFileSync(resolve('src/renderer/src', file), 'utf8')
const REMOVED_CONTROLS =
  /planMode|Plan Mode|WorkPlanShapeMenu|data-shape|stripPlanModeToken|commitContext|ProposedChainBanner/
it('mounts no prompt-and-Send bar in the launcher or on the PTY work rail', () => {
  // Sal, 2026-09-18: "+" starts a conversation with one click and no prompt box, and the
  // rail's field duplicated the composer or terminal under it. The conversation's own
  // composer or terminal is the one input.
  for (const file of [
    'components/sidebar/session-folders/NewConversationButton.tsx',
    'components/native-chat/PtySessionWorkRail.tsx'
  ]) {
    const text = source(file)
    expect(text).not.toContain('WorkPlanComposerBar')
    expect(text).not.toMatch(REMOVED_CONTROLS)
  }
  // Resume still hands its one line to the PTY through the same door as before.
  expect(source('components/native-chat/PtySessionWorkRail.tsx')).toContain(
    'submitPromptToAgentPty'
  )
})
it('lets the chat composer send through its own Send: the bar is not mounted there', () => {
  const composer = source('components/native-chat/NativeChatComposer.tsx')
  expect(composer).not.toContain('WorkPlanComposerBar')
  expect(composer).not.toMatch(REMOVED_CONTROLS)
  // The native Send is back: nothing hides it behind a work-plan slot any more.
  expect(source('components/native-chat/NativeChatComposerField.tsx')).not.toMatch(
    /workPlanBar|hideSend/
  )
  expect(source('components/native-chat/use-native-chat-work-plan-send-actions.ts')).toContain(
    'void nativeSend(draft)'
  )
})
it('keeps the bar free of Plan Mode, shapes, Outcome, live chain and persistence', () => {
  const bar = source('components/work-plan/WorkPlanComposerBar.tsx')
  expect(bar).not.toMatch(REMOVED_CONTROLS)
  expect(bar).not.toMatch(/Outcome|liveChain|commitWorkPlan|WorkPlanComposerDialog/)
  expect(bar).not.toMatch(/sessionChains|useAppStore|appendSubmission|outcomeDiscovery/)
  expect(source('components/sidebar/session-folders/NewConversationButton.tsx')).not.toContain(
    'WorkPlanComposerBar'
  )
})
