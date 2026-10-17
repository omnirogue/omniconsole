import { describe, expect, it, vi } from 'vitest'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { CodexAcquisitionWindow } from './codex-structured-acquisition-window'
import {
  applyCodexStructuredSessionOption,
  readCodexStructuredSessionOptions,
  reportedCodexThreadOptions,
  restoredCodexSessionOptions
} from './codex-structured-session-options'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import type { CodexSession } from './codex-structured-session-state'

function optionSession(request: CodexAppServerConnection['request']): CodexSession {
  return {
    connection: {
      pid: 1,
      closed: false,
      request,
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => true
    },
    backgroundTasks: new CodexBackgroundTaskTracker('thread-1'),
    ended: false,
    requestedClose: false,
    fence: 1,
    acquisitionGeneration: 'generation-1',
    threadId: 'thread-1',
    historyPath: null,
    prompts: new CodexAcquisitionWindow().prompts,
    options: new Map(),
    reportedOptions: { model: 'gpt-live', effort: 'high' },
    turnIdWaiters: [],
    translator: null
  }
}

describe('structured Codex session options', () => {
  it('filters restored records to recognized turn options', () => {
    expect(
      Object.fromEntries(
        restoredCodexSessionOptions({
          model: 'gpt-live',
          effort: 'high',
          threadId: 'thread-injected',
          input: 'input-injected'
        })
      )
    ).toEqual({ model: 'gpt-live', effort: 'high' })
  })

  it('hydrates paged provider models and their supported efforts', async () => {
    const request = vi.fn(async (_method: string, params?: Record<string, unknown>) =>
      params?.cursor
        ? {
            data: [
              {
                model: 'gpt-second',
                displayName: 'GPT Second',
                description: 'Fast',
                hidden: false,
                supportedReasoningEfforts: [
                  { reasoningEffort: 'low', description: 'Quick reasoning' }
                ],
                defaultReasoningEffort: 'low',
                isDefault: false
              }
            ],
            nextCursor: null
          }
        : {
            data: [
              {
                model: 'gpt-live',
                displayName: 'GPT Live',
                hidden: false,
                supportedReasoningEfforts: [
                  { reasoningEffort: 'medium', description: 'Balanced' },
                  { reasoningEffort: 'high', description: 'Deep reasoning' }
                ],
                defaultReasoningEffort: 'medium',
                isDefault: true
              }
            ],
            nextCursor: 'page-2'
          }
    )

    await expect(
      readCodexStructuredSessionOptions({
        connection: { request } as never,
        current: { model: 'gpt-live', effort: 'medium' }
      })
    ).resolves.toEqual({
      models: [
        {
          id: 'gpt-live',
          label: 'GPT Live',
          isDefault: true,
          defaultEffort: 'medium',
          efforts: [
            { value: 'medium', label: 'Medium', description: 'Balanced' },
            { value: 'high', label: 'High', description: 'Deep reasoning' }
          ]
        },
        {
          id: 'gpt-second',
          label: 'GPT Second',
          description: 'Fast',
          isDefault: false,
          defaultEffort: 'low',
          efforts: [{ value: 'low', label: 'Low', description: 'Quick reasoning' }]
        }
      ],
      current: { model: 'gpt-live', effort: 'medium' }
    })
    expect(request).toHaveBeenNthCalledWith(
      2,
      'model/list',
      { limit: 100, includeHidden: false, cursor: 'page-2' },
      { timeoutMs: undefined }
    )
  })

  it('hydrates current values from thread start or resume', () => {
    expect(
      reportedCodexThreadOptions({
        threadId: 'thread-1',
        historyPath: null,
        model: 'gpt-live',
        effort: 'high'
      })
    ).toEqual({ model: 'gpt-live', effort: 'high' })
  })

  it('reconciles an incompatible effort when only the model changes', async () => {
    const session = optionSession(
      vi.fn(async () => ({
        data: [
          {
            model: 'gpt-live',
            supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
            defaultReasoningEffort: 'high'
          },
          {
            model: 'gpt-fast',
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
            defaultReasoningEffort: 'low'
          }
        ],
        nextCursor: null
      }))
    )

    await expect(
      applyCodexStructuredSessionOption(session, 'model', 'gpt-fast', undefined)
    ).resolves.toEqual({ model: 'gpt-fast', effort: 'low' })
  })

  it('keeps the closest effort the new model offers instead of dropping to its default', async () => {
    const session = optionSession(
      vi.fn(async () => ({
        data: [
          {
            model: 'gpt-live',
            supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }],
            defaultReasoningEffort: 'xhigh'
          },
          {
            model: 'gpt-mid',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low' },
              { reasoningEffort: 'medium' },
              { reasoningEffort: 'high' }
            ],
            defaultReasoningEffort: 'medium'
          }
        ],
        nextCursor: null
      }))
    )
    session.reportedOptions = { model: 'gpt-live', effort: 'xhigh' }

    await expect(
      applyCodexStructuredSessionOption(session, 'model', 'gpt-mid', undefined)
    ).resolves.toEqual({ model: 'gpt-mid', effort: 'high' })
  })

  it('steps up to the next effort when the new model has nothing lower, and never picks the floor blindly', async () => {
    const session = optionSession(
      vi.fn(async () => ({
        data: [
          { model: 'gpt-live', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
          {
            model: 'gpt-deep',
            supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }, { reasoningEffort: 'max' }]
          },
          {
            model: 'gpt-odd',
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }]
          }
        ],
        nextCursor: null
      }))
    )
    session.reportedOptions = { model: 'gpt-live', effort: 'medium' }

    await expect(
      applyCodexStructuredSessionOption(session, 'model', 'gpt-deep', undefined)
    ).resolves.toEqual({ model: 'gpt-deep', effort: 'xhigh' })

    // Why: an effort the ranking does not know falls to the model default, else the top.
    session.options.clear()
    session.reportedOptions = { model: 'gpt-live', effort: 'turbo' }
    await expect(
      applyCodexStructuredSessionOption(session, 'model', 'gpt-odd', undefined)
    ).resolves.toEqual({ model: 'gpt-odd', effort: 'high' })
  })

  it('steps an ultra session down to max on a model whose ceiling is max', async () => {
    // Codex's model cache advertises `ultra` for Sol, Terra and Astra; a switch to a
    // max-ceiling model used to fall to that model's default because ultra was unranked.
    const session = optionSession(
      vi.fn(async () => ({
        data: [
          {
            model: 'gpt-6-astra',
            supportedReasoningEfforts: [{ reasoningEffort: 'max' }, { reasoningEffort: 'ultra' }],
            defaultReasoningEffort: 'medium'
          },
          {
            model: 'gpt-5.6-luna',
            supportedReasoningEfforts: [
              { reasoningEffort: 'medium' },
              { reasoningEffort: 'high' },
              { reasoningEffort: 'xhigh' },
              { reasoningEffort: 'max' }
            ],
            defaultReasoningEffort: 'medium'
          }
        ],
        nextCursor: null
      }))
    )
    session.reportedOptions = { model: 'gpt-6-astra', effort: 'ultra' }

    await expect(
      applyCodexStructuredSessionOption(session, 'model', 'gpt-5.6-luna', undefined)
    ).resolves.toEqual({ model: 'gpt-5.6-luna', effort: 'max' })
  })

  it('rejects values absent from the provider catalog', async () => {
    const session = optionSession(
      vi.fn(async () => ({
        data: [{ model: 'gpt-live', supportedReasoningEfforts: [] }],
        nextCursor: null
      }))
    )

    await expect(
      applyCodexStructuredSessionOption(session, 'model', 'not-entitled', undefined)
    ).rejects.toThrow('does not offer model not-entitled')
    await expect(
      applyCodexStructuredSessionOption(session, 'effort', 'high', undefined)
    ).rejects.toThrow('does not support high')
  })
})
