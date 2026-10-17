import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeOrigin, codexOrigin, readTranscriptOrigin } from './transcript-origin'

const meta = (payload: object) => JSON.stringify({ type: 'session_meta', payload })

describe('transcript origin', () => {
  it('reads a Codex session as interactive, headless or a spawned worker', () => {
    expect(codexOrigin(meta({ originator: 'codex-tui', source: 'cli' }))).toEqual({
      headless: false,
      parentSessionId: null
    })
    expect(codexOrigin(meta({ originator: 'codex_exec', source: 'exec' }))).toEqual({
      headless: true,
      parentSessionId: null
    })
    const parent = '01A0C107-10bd-7ce0-8bb0-27daddf4fe8b'
    expect(
      codexOrigin(
        meta({ source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } } })
      )
    ).toEqual({ headless: true, parentSessionId: parent.toLowerCase(), worker: true })
    expect(codexOrigin('not json')).toEqual({ headless: false, parentSessionId: null })
  })

  it.each([
    { other: 'guardian' },
    { thread_spawn: {} },
    { thread_spawn: { parent_thread_id: '../not-a-session' } }
  ])('keeps explicit worker provenance without a usable parent: %j', (subagent) => {
    expect(codexOrigin(meta({ source: { subagent } }))).toEqual({
      headless: true,
      parentSessionId: null,
      worker: true
    })
  })

  it('reads a Claude session as headless only when it came through the SDK', () => {
    const line = (entrypoint: string) => JSON.stringify({ type: 'user', entrypoint })
    expect(claudeOrigin(`${JSON.stringify({ type: 'summary' })}\n${line('cli')}`).headless).toBe(
      false
    )
    expect(claudeOrigin(line('sdk-cli')).headless).toBe(true)
    expect(claudeOrigin('').headless).toBe(false)
  })

  it('reads only the head of the transcript file, and a missing file is interactive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'origin-'))
    const path = join(dir, 'rollout.jsonl')
    writeFileSync(
      path,
      `${meta({ source: 'exec', base_instructions: 'x'.repeat(200_000) })}\n{"more":1}\n`
    )
    expect(readTranscriptOrigin(path, 'codex').headless).toBe(true)
    expect(readTranscriptOrigin(join(dir, 'missing.jsonl'), 'claude')).toEqual({
      headless: false,
      parentSessionId: null
    })
  })
})
