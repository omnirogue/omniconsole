import { describe, expect, it, vi } from 'vitest'
import {
  readTerminalSessionOutcomeSourceContext,
  type TerminalOutcomeSourceInput
} from './session-outcome-source-context'

const completedSource: TerminalOutcomeSourceInput = {
  paneKey: 'tab-source:leaf-source',
  handle: 'pty-source',
  processIncarnation: 'process-source-17',
  agent: 'codex',
  shell: 'posix',
  status: { state: 'done', lastAssistantMessage: 'The requested report is finished.' }
}

describe('readTerminalSessionOutcomeSourceContext', () => {
  it('leaves a completed source with no proven model unresolved', async () => {
    const readRecords = vi
      .fn()
      .mockResolvedValue([{ type: 'response_item', payload: { model: 'quoted-prompt-model' } }])
    const source = {
      ...completedSource,
      transcriptPath: '/provider/sessions/source.jsonl'
    }
    expect(await readTerminalSessionOutcomeSourceContext(source, readRecords)).toBeNull()
    expect(readRecords).toHaveBeenCalledExactlyOnceWith(source.transcriptPath)
  })

  it('uses only the pinned transcript’s actor metadata and the actual final summary', async () => {
    const transcriptPath = '/provider/sessions/source.jsonl'
    const summary = [
      'Delivered the final report and supporting data.',
      '/workspace/reports/final.md',
      '/workspace/reports/results.csv',
      '/workspace/reports/final.md'
    ].join('\n')
    const readRecords = vi.fn().mockResolvedValue([
      { type: 'turn_context', payload: { model: 'earlier-model', effort: 'low' } },
      { type: 'turn_context', payload: { model: 'actual-model', effort: 'high' } },
      {
        type: 'response_item',
        payload: { text: 'Private earlier draft: /workspace/private/internal.md' }
      }
    ])
    const result = await readTerminalSessionOutcomeSourceContext(
      {
        ...completedSource,
        transcriptPath,
        launchCommand: 'codex --model launch-model',
        status: { state: 'done', model: 'lifecycle-model', lastAssistantMessage: `  ${summary}\n` }
      },
      readRecords
    )
    expect(readRecords).toHaveBeenCalledExactlyOnceWith(transcriptPath)
    expect(result).toEqual({
      paneKey: completedSource.paneKey,
      handle: completedSource.handle,
      processIncarnation: completedSource.processIncarnation,
      agent: 'codex',
      model: 'actual-model',
      effort: 'high',
      summary,
      files: ['/workspace/reports/final.md', '/workspace/reports/results.csv']
    })
    expect(result?.files).not.toContain(transcriptPath)
    expect(JSON.stringify(result)).not.toContain('Private earlier draft')
    expect(result?.files).not.toContain('/workspace/private/internal.md')
  })

  it.each([
    { label: 'working', status: { state: 'working' } },
    { label: 'waiting', status: { state: 'waiting' } },
    { label: 'blocked', status: { state: 'blocked' } },
    { label: 'interrupted completion', status: { interrupted: true } },
    { label: 'session boundary', status: { sessionBoundary: true } },
    { label: 'tool output', status: { lastAssistantMessageIsToolOutput: true } },
    { label: 'missing final message', status: { lastAssistantMessage: undefined } },
    { label: 'blank final message', status: { lastAssistantMessage: ' \n ' } }
  ] satisfies { label: string; status: Partial<TerminalOutcomeSourceInput['status']> }[])(
    'rejects $label before reading the transcript',
    async ({ status }) => {
      const readRecords = vi
        .fn()
        .mockResolvedValue([{ type: 'turn_context', payload: { model: 'actual-model' } }])
      const result = await readTerminalSessionOutcomeSourceContext(
        {
          ...completedSource,
          transcriptPath: '/provider/sessions/source.jsonl',
          status: { ...completedSource.status, model: 'observed-model', ...status }
        },
        readRecords
      )
      expect(result).toBeNull()
      expect(readRecords).not.toHaveBeenCalled()
    }
  )

  it('retains explicit captured launch model and effort when transcript reading fails', async () => {
    const readRecords = vi.fn().mockRejectedValue(new Error('Pinned transcript is unavailable'))
    const result = await readTerminalSessionOutcomeSourceContext(
      {
        ...completedSource,
        launchCommand: 'codex --model captured-model',
        launchArgs: '-c model_reasoning_effort="high"',
        transcriptPath: '/provider/sessions/source.jsonl'
      },
      readRecords
    )
    expect(result).toEqual({
      paneKey: completedSource.paneKey,
      handle: completedSource.handle,
      processIncarnation: completedSource.processIncarnation,
      agent: 'codex',
      model: 'captured-model',
      effort: 'high',
      summary: completedSource.status.lastAssistantMessage,
      files: []
    })
    expect(readRecords).toHaveBeenCalledExactlyOnceWith('/provider/sessions/source.jsonl')
  })

  it('retains an unresolved model when transcript reading fails without explicit source evidence', async () => {
    const readRecords = vi.fn().mockRejectedValue(new Error('Pinned transcript is unavailable'))
    expect(
      await readTerminalSessionOutcomeSourceContext(
        { ...completedSource, transcriptPath: '/provider/sessions/source.jsonl' },
        readRecords
      )
    ).toBeNull()
  })

  it('does not read or discover transcripts when the source has no pinned transcript path', async () => {
    const readRecords = vi.fn()
    const result = await readTerminalSessionOutcomeSourceContext(
      {
        ...completedSource,
        status: { ...completedSource.status, model: 'observed-model' }
      },
      readRecords
    )
    expect(result).toMatchObject({ model: 'observed-model', files: [] })
    expect(readRecords).not.toHaveBeenCalled()
  })
})
