import { describe, expect, it } from 'vitest'
import { attentionPaneTitle, describeAttentionAsk } from './attention-pane-labels'

describe('describeAttentionAsk', () => {
  it('reads the first question out of an AskUserQuestion payload', () => {
    expect(
      describeAttentionAsk('{"questions":[{"question":"Deploy to prod?","header":"Deploy"}]}')
    ).toBe('Deploy to prod?')
    expect(describeAttentionAsk('{"question":"Which branch?"}')).toBe('Which branch?')
  })

  it('falls back to plain text and ignores empty or foreign shapes', () => {
    expect(describeAttentionAsk('Approve the plan')).toBe('Approve the plan')
    expect(describeAttentionAsk('{"foo":1}')).toBeNull()
    expect(describeAttentionAsk('   ')).toBeNull()
    expect(describeAttentionAsk(undefined)).toBeNull()
  })
})

describe('attentionPaneTitle', () => {
  it('prefers the pane title and falls back to the workspace name', () => {
    expect(attentionPaneTitle({ title: 'Fix login', worktreeName: 'main' })).toBe('Fix login')
    expect(attentionPaneTitle({ title: '  ', worktreeName: 'main' })).toBe('main')
  })
})
