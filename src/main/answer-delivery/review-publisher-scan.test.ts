import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PUBLISHER_SCAN_LIMITS,
  publisherScanner,
  transcriptPublishedSlug
} from './review-publisher-scan'

const SLUG = '1a1463cfb969aad9b'
const call = (id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input }] }
  })
const result = (id: string, text: string) =>
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] }
  })
const published = [
  call('p1', 'Bash', { command: '~/Work/Ops/bin/work-decision ask --title Plan' }),
  result('p1', `published https://console.example.com/a/${SLUG}`)
].join('\n')
/** A coordinator that only read and waited on the page. */
const readerOnly = [
  call('r1', 'Bash', { command: `omni artifacts status ${SLUG} --json` }),
  result('r1', `{"slug":"${SLUG}","status":"pending"}`),
  call('r2', 'Bash', { command: `work-decision wait ${SLUG}` }),
  result('r2', `[choices] ${SLUG} approved`)
].join('\n')

describe('transcriptPublishedSlug', () => {
  it('takes only a publish call’s own result naming the page', () => {
    expect(transcriptPublishedSlug(published, SLUG)).toBe(true)
    expect(
      transcriptPublishedSlug(
        [
          call('m1', 'mcp__omni-console__artifact_publish', { title: 'Plan' }),
          result('m1', `{"slug":"${SLUG}"}`)
        ].join('\n'),
        SLUG
      )
    ).toBe(true)
    expect(transcriptPublishedSlug(readerOnly, SLUG)).toBe(false)
    expect(transcriptPublishedSlug(published, 'another-slug')).toBe(false)
  })
})

describe('publisherScanner', () => {
  let root = ''
  const now = Date.parse('2026-10-16T20:00:00Z')
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'publisher-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })
  function transcript(project: string, id: string, body: string, ageMs: number) {
    mkdirSync(join(root, project), { recursive: true })
    const path = join(root, project, `${id}.jsonl`)
    writeFileSync(path, `${body}\n`)
    const seconds = (now - ageMs) / 1000
    utimesSync(path, seconds, seconds)
    return path
  }

  it('finds the publishing session and not one that only read the page', async () => {
    transcript('-Work', 'reader', readerOnly, 1000)
    transcript('-Work-x', 'publisher', published, 5000)
    const scan = publisherScanner(
      async () => [root],
      PUBLISHER_SCAN_LIMITS,
      () => now
    )
    expect(await scan(SLUG)).toMatchObject({ sessionId: 'publisher' })
  })

  it('reads at most maxFiles of the newest transcripts, none past maxAgeMs', async () => {
    transcript('-Work', 'publisher', published, 60_000)
    transcript('-Work', 'newer-1', readerOnly, 1000)
    transcript('-Work', 'newer-2', readerOnly, 2000)
    const limits = { ...PUBLISHER_SCAN_LIMITS, maxFiles: 2 }
    expect(
      await publisherScanner(
        async () => [root],
        limits,
        () => now
      )(SLUG)
    ).toBeNull()
    const fresh = { ...PUBLISHER_SCAN_LIMITS, maxAgeMs: 30_000 }
    expect(
      await publisherScanner(
        async () => [root],
        fresh,
        () => now
      )(SLUG)
    ).toBeNull()
    expect(
      await publisherScanner(
        async () => [root],
        PUBLISHER_SCAN_LIMITS,
        () => now
      )(SLUG)
    ).toMatchObject({ sessionId: 'publisher' })
  })

  it('stops stat’ing at maxStats and reads only each tail', async () => {
    transcript('-Work', 'publisher', `${published}\n${readerOnly.repeat(50)}`, 1000)
    const tail = { ...PUBLISHER_SCAN_LIMITS, tailBytes: 2048 }
    expect(
      await publisherScanner(
        async () => [root],
        tail,
        () => now
      )(SLUG)
    ).toBeNull()
    const noStats = { ...PUBLISHER_SCAN_LIMITS, maxStats: 1 }
    transcript('-Work-y', 'publisher-2', published, 1000)
    // One stat is spent on a project folder, so no transcript is read at all.
    expect(
      await publisherScanner(
        async () => [root],
        noStats,
        () => now
      )(SLUG)
    ).toBeNull()
  })

  it('keeps a result, found or not, for cacheMs', async () => {
    let clock = now
    const roots = vi.fn(async () => [root])
    const scan = publisherScanner(roots, { ...PUBLISHER_SCAN_LIMITS, cacheMs: 1000 }, () => clock)
    expect(await scan(SLUG)).toBeNull()
    transcript('-Work', 'publisher', published, 0)
    expect(await scan(SLUG)).toBeNull()
    expect(roots).toHaveBeenCalledOnce()
    clock += 1000
    expect(await scan(SLUG)).toMatchObject({ sessionId: 'publisher' })
  })
})
