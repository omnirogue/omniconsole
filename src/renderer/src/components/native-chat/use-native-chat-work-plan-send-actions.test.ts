import { describe, expect, it, vi } from 'vitest'
import {
  useNativeChatWorkPlanSendActions,
  type NativeChatWorkPlanSendDeps
} from './use-native-chat-work-plan-send-actions'

function deps(overrides: Partial<NativeChatWorkPlanSendDeps> = {}): NativeChatWorkPlanSendDeps {
  return {
    tags: { blocked: false, tagging: false, active: false, send: vi.fn() },
    disabled: false,
    isWorking: false,
    hasImageAttachments: false,
    draft: 'Use the other file',
    queuePrompt: vi.fn(() => false),
    prepareSessions: vi.fn(() => false),
    classifySend: vi.fn(() => 'chat'),
    deliver: vi.fn(() => true),
    engineerSend: vi.fn((text, deliverDraft) => deliverDraft(text)),
    deliverDraft: vi.fn(() => true),
    ...overrides
  }
}

describe.each([false, true])('regular Send (working=%s)', (isWorking) => {
  it('delivers the correction without scheduling it in Next Steps', () => {
    const d = deps({ isWorking })
    useNativeChatWorkPlanSendActions(d).send()
    expect(d.deliverDraft).toHaveBeenCalledExactlyOnceWith('Use the other file')
  })
  it('keeps Alt/Option+Enter equivalent to Send', () => {
    const d = deps({ isWorking })
    useNativeChatWorkPlanSendActions(d).sendNow()
    expect(d.deliverDraft).toHaveBeenCalledExactlyOnceWith('Use the other file')
  })
  it('schedules only an explicit /next command', () => {
    const d = deps({ isWorking, draft: '/next run tests', queuePrompt: vi.fn(() => true) })
    useNativeChatWorkPlanSendActions(d).send()
    expect(d.queuePrompt).toHaveBeenCalledWith('/next run tests')
    expect(d.prepareSessions).not.toHaveBeenCalled()
    expect(d.deliverDraft).not.toHaveBeenCalled()
  })
  it('prepares sessions after /next loses and before chat send', () => {
    const d = deps({
      isWorking,
      draft: 'create sessions for one and two',
      prepareSessions: vi.fn(() => true)
    })
    useNativeChatWorkPlanSendActions(d).send()
    expect(d.queuePrompt).toHaveBeenCalledWith('create sessions for one and two')
    expect(d.prepareSessions).toHaveBeenCalledWith('create sessions for one and two')
    expect(d.deliverDraft).not.toHaveBeenCalled()
  })
  it('delivers slash commands without prompt rewriting', () => {
    const d = deps({ isWorking, draft: '/status', classifySend: () => 'command' })
    useNativeChatWorkPlanSendActions(d).send()
    expect(d.deliver).toHaveBeenCalledExactlyOnceWith('/status')
    expect(d.engineerSend).not.toHaveBeenCalled()
  })
  it('keeps images on the normal delivery path', () => {
    const d = deps({ isWorking, hasImageAttachments: true })
    useNativeChatWorkPlanSendActions(d).send()
    expect(d.deliverDraft).toHaveBeenCalledOnce()
  })
  it('leaves tagged messages to their own delivery', () => {
    const d = deps({
      isWorking,
      tags: { blocked: false, tagging: false, active: true, send: vi.fn() }
    })
    useNativeChatWorkPlanSendActions(d).send()
    expect(d.tags.send).toHaveBeenCalledOnce()
    expect(d.queuePrompt).not.toHaveBeenCalled()
    expect(d.deliverDraft).not.toHaveBeenCalled()
  })
  it.each([{ disabled: true }, { draft: '   ' }])(
    'does not send unavailable or empty input',
    (overrides) => {
      const d = deps({ isWorking, ...overrides })
      useNativeChatWorkPlanSendActions(d).send()
      expect(d.deliverDraft).not.toHaveBeenCalled()
    }
  )
})
