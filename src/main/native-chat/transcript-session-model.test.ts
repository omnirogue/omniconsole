import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readNativeChatTranscriptTail, subscribeNativeChatTranscript } from './transcript-watch'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function change(provider: string, model: string): string {
  return `${JSON.stringify({ type: 'model_change', provider, model })}\n`
}

function reply(provider: string, model: string): string {
  return `${JSON.stringify({
    type: 'message',
    id: `${provider}-reply`,
    timestamp: '2026-09-17T12:00:00Z',
    message: { role: 'assistant', provider, model, content: [{ type: 'text', text: 'done' }] }
  })}\n`
}

async function file(contents: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omni-session-model-'))
  roots.push(root)
  const path = join(root, 'session.jsonl')
  await writeFile(path, contents)
  return path
}

describe('owning transcript model identity', () => {
  it('reads OMP qualified model-change rows without requiring an inference', async () => {
    const before = reply('openrouter', 'google/gemini-2.5-flash-lite')
    const model = 'openrouter/google/gemini-2.5-flash'
    const filePath = await file(
      `${before}${JSON.stringify({ type: 'model_change', model, resolvedModelIsFallback: false })}\n`
    )
    const args = { agent: 'omp' as const, sessionId: 'owned', filePath, limit: 1 }
    expect(await readNativeChatTranscriptTail(args)).toMatchObject({ model })
    expect(
      await readNativeChatTranscriptTail({ ...args, beforeOffset: Buffer.byteLength(before) })
    ).not.toHaveProperty('model')
  })

  it('restores full provider/model and honors a switch after the last assistant reply', async () => {
    const before = reply('google', 'gemini-2.5-flash-lite')
    const filePath = await file(before + change('openrouter', 'google/gemini-2.5-flash-lite'))
    const args = { agent: 'omp' as const, sessionId: 'owned', filePath, limit: 1 }
    expect(await readNativeChatTranscriptTail(args)).toMatchObject({
      model: 'openrouter/google/gemini-2.5-flash-lite',
      messages: [{ id: 'google-reply' }]
    })
    const older = await readNativeChatTranscriptTail({
      ...args,
      beforeOffset: Buffer.byteLength(before)
    })
    expect(older).not.toHaveProperty('model')
  })

  it('recovers the actual responding provider without inferring one from a bare model label', async () => {
    const filePath = await file(reply('openrouter', 'moonshotai/kimi-k2.5'))
    const args = { agent: 'omp' as const, sessionId: 'owned', filePath, limit: 5 }
    expect(await readNativeChatTranscriptTail(args)).toMatchObject({
      model: 'openrouter/moonshotai/kimi-k2.5'
    })
    await writeFile(
      filePath,
      `${JSON.stringify({ type: 'model_change', model: 'Gemini 2.5 Flash Lite' })}\n`
    )
    expect(await readNativeChatTranscriptTail(args)).not.toHaveProperty('model')
  })

  it('publishes model-only live changes and clears replaced transcript evidence', async () => {
    const filePath = await file(change('openrouter', 'google/gemini-2.5-flash-lite'))
    const initial: (string | undefined)[] = []
    const replacements: (string | undefined)[] = []
    const appends: { count: number; model?: string }[] = []
    const subscription = await subscribeNativeChatTranscript({
      agent: 'omp',
      sessionId: 'owned',
      filePath,
      initialLimit: 5,
      debounceMs: 5,
      onInitialSnapshot: (_messages, _hasMore, _offset, _error, _lifecycle, model) =>
        initial.push(model),
      onReplace: (_messages, _hasMore, _offset, _lifecycle, model) => replacements.push(model),
      onAppend: (messages, _lifecycle, model) => appends.push({ count: messages.length, model })
    })
    try {
      await vi.waitFor(() => expect(initial).toEqual(['openrouter/google/gemini-2.5-flash-lite']))
      await appendFile(
        filePath,
        `${JSON.stringify({ type: 'model_change', model: 'openrouter/moonshotai/kimi-k2.5' })}\n`
      )
      await vi.waitFor(() =>
        expect(appends).toContainEqual({ count: 0, model: 'openrouter/moonshotai/kimi-k2.5' })
      )
      await writeFile(filePath, '{}\n')
      await vi.waitFor(() => expect(replacements).toEqual([undefined]))
    } finally {
      subscription.unsubscribe()
    }
  })
})
