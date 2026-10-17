import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LOCAL_LOG_TAIL_CHUNK_BYTES } from '../../shared/local-log-tail-types'
import { resolveCapacityRecoverySourceModel } from './conversation-capacity-source-model'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function assistant(model: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'current-session',
    message: { role: 'assistant', model },
    ...fields
  })
}

function user(): string {
  return JSON.stringify({
    type: 'user',
    sessionId: 'current-session',
    message: { role: 'user', content: 'Continue' }
  })
}

async function source(content: string) {
  const root = await mkdtemp(join(tmpdir(), 'omni-capacity-source-model-'))
  roots.push(root)
  const transcriptPath = join(root, 'selected-session.jsonl')
  await writeFile(transcriptPath, content)
  return {
    agent: 'claude' as const,
    providerSessionId: 'current-session',
    transcriptPath
  }
}

describe('capacity recovery source model', () => {
  it('uses a hook model without requiring transcript access', async () => {
    expect(
      await resolveCapacityRecoverySourceModel({
        agent: 'claude',
        model: 'claude-opus-4-6',
        providerSessionId: 'current-session',
        transcriptPath: '/missing/session.jsonl'
      })
    ).toBe('claude-opus-4-6')
  })

  it('uses the current turn model after a native model change, ignoring other sessions and children', async () => {
    const input = await source(
      [
        assistant('claude-fable-5'),
        user(),
        assistant('claude-opus-4-6'),
        assistant('claude-fable-5', { sessionId: 'other-session' }),
        assistant('claude-fable-5', { isSidechain: true }),
        assistant('claude-fable-5', { parent_tool_use_id: 'child-tool' }),
        ''
      ].join('\n')
    )
    expect(await resolveCapacityRecoverySourceModel(input)).toBe('claude-opus-4-6')
  })

  it('does not use a preceding turn when the current prompt has no assistant model', async () => {
    const input = await source([assistant('claude-fable-5'), user(), ''].join('\n'))
    expect(await resolveCapacityRecoverySourceModel(input)).toBeUndefined()
  })

  it.each([assistant('<synthetic>'), assistant('claude-fable-5', { isApiErrorMessage: true })])(
    'uses same-turn model evidence before a synthetic failure: %s',
    async (error) => {
      const input = await source([user(), assistant('claude-opus-4-6'), error, ''].join('\n'))
      expect(await resolveCapacityRecoverySourceModel(input)).toBe('claude-opus-4-6')
      await writeFile(
        input.transcriptPath,
        [assistant('claude-fable-5'), user(), error, ''].join('\n')
      )
      expect(await resolveCapacityRecoverySourceModel(input)).toBeUndefined()
      await writeFile(
        input.transcriptPath,
        [
          assistant('claude-fable-5'),
          JSON.stringify({
            type: 'system',
            sessionId: 'current-session',
            subtype: 'local_command'
          }),
          error,
          ''
        ].join('\n')
      )
      expect(await resolveCapacityRecoverySourceModel(input)).toBeUndefined()
    }
  )

  it.each([
    assistant('claude-fable-5', { message: { role: 'assistant' } }),
    assistant('default'),
    assistant('auto'),
    '{ malformed record'
  ])('does not reuse an earlier model after an unproven final record: %s', async (last) => {
    const input = await source([user(), assistant('claude-fable-5'), last, ''].join('\n'))
    expect(await resolveCapacityRecoverySourceModel(input)).toBeUndefined()
  })

  it('does not infer a model from a partial final record', async () => {
    const input = await source(`${assistant('claude-fable-5')}\n{"type":"assistant"`)
    expect(await resolveCapacityRecoverySourceModel(input)).toBeUndefined()
  })

  it('only considers complete records inside the bounded selected transcript tail', async () => {
    const filler = JSON.stringify({
      type: 'progress',
      content: 'x'.repeat(LOCAL_LOG_TAIL_CHUNK_BYTES)
    })
    const input = await source([assistant('claude-fable-5'), filler, ''].join('\n'))
    expect(await resolveCapacityRecoverySourceModel(input)).toBeUndefined()
    await writeFile(
      input.transcriptPath,
      [filler, user(), assistant('claude-opus-4-6'), ''].join('\n')
    )
    expect(await resolveCapacityRecoverySourceModel(input)).toBe('claude-opus-4-6')
  })

  it('leaves unknown models unknown for missing files, other sessions, and other providers', async () => {
    const input = await source(`${assistant('claude-fable-5', { sessionId: 'other-session' })}\n`)
    expect(await resolveCapacityRecoverySourceModel(input)).toBeUndefined()
    expect(
      await resolveCapacityRecoverySourceModel({
        ...input,
        transcriptPath: join(roots[0]!, 'missing')
      })
    ).toBeUndefined()
    expect(await resolveCapacityRecoverySourceModel({ ...input, agent: 'codex' })).toBeUndefined()
  })
})
