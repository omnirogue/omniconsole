import { describe, expect, it } from 'vitest'
import { normalizeLaunchContextSettingsUpdate } from './launch-context-settings'

describe('normalizeLaunchContextSettingsUpdate', () => {
  it('touches only the keys present in the update', () => {
    expect(normalizeLaunchContextSettingsUpdate({ defaultTuiAgent: 'claude' })).toEqual({})
    expect(normalizeLaunchContextSettingsUpdate({ agentTemplates: undefined })).toEqual({
      agentTemplates: {}
    })
  })

  it('normalizes both launcher keys through their own sanitizers', () => {
    const result = normalizeLaunchContextSettingsUpdate({
      agentTemplates: {
        custom: [{ id: 'docs', name: 'Docs', description: '', instructions: 'Write docs.' }]
      },
      launchContextMemory: {
        'worktree:a': { templateId: 'docs', ollamaModel: 'gemma3:12b' },
        'folder:b': { templateId: 'default', ollamaModel: 'nope tag' }
      }
    })
    expect(result.agentTemplates?.custom?.[0]).toMatchObject({ id: 'docs', name: 'Docs' })
    expect(result.launchContextMemory).toEqual({
      'worktree:a': { templateId: 'docs', ollamaModel: 'gemma3:12b' },
      'folder:b': { templateId: 'default' }
    })
  })
})
