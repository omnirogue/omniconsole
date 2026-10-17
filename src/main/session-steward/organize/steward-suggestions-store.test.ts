import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  STEWARD_DISMISSED_PAIR_MS,
  STEWARD_SUGGESTION_TTL_MS,
  StewardSuggestionsStore,
  type StewardSuggestionProposal
} from './steward-suggestions-store'

const DAY = 24 * 60 * 60 * 1000
let directory: string
let now: number

function store(): StewardSuggestionsStore {
  return new StewardSuggestionsStore({ directory, now: () => now })
}

function merge(first: string, second: string): StewardSuggestionProposal {
  return {
    kind: 'merge',
    targets: [{ sessionKey: first }, { sessionKey: second }],
    proposal: { into: { sessionKey: second } },
    title: `Merge “${first}” into “${second}”?`,
    evidence: 'Same deliverable (0.92 both ways), 4 shared files'
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'steward-suggestions-'))
  now = Date.parse('2026-09-26T10:00:00Z')
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('steward suggestions store', () => {
  it('keeps one open suggestion per pair, whatever order the sessions are named in', async () => {
    const suggestions = store()
    const first = await suggestions.propose(merge('a', 'b'))
    const again = await suggestions.propose(merge('b', 'a'))
    expect(again?.id).toBe(first?.id)
    expect(first).toMatchObject({
      kind: 'merge',
      state: 'open',
      pairKey: 'merge:a|b',
      title: 'Merge “a” into “b”?',
      evidence: 'Same deliverable (0.92 both ways), 4 shared files',
      expiresAt: now + STEWARD_SUGGESTION_TTL_MS
    })
    expect((await suggestions.open('merge')).map((entry) => entry.id)).toEqual([first!.id])
    expect(await suggestions.open('project')).toEqual([])
  })

  it('remembers a dismissed pair for 30 days, across a restart', async () => {
    const suggestions = store()
    const first = await suggestions.propose(merge('a', 'b'))
    const dismissed = await suggestions.dismiss(first!.id)
    expect(dismissed).toMatchObject({ state: 'dismissed', decidedAt: now })
    await suggestions.flush()

    now += 29 * DAY
    const reloaded = store()
    expect(await reloaded.wasDismissed('merge:a|b')).toBe(true)
    expect(await reloaded.propose(merge('b', 'a'))).toBeNull()
    expect(await reloaded.open()).toEqual([])
    // Another pair is unaffected.
    expect(await reloaded.propose(merge('a', 'c'))).not.toBeNull()

    now = now - 29 * DAY + STEWARD_DISMISSED_PAIR_MS
    expect(await reloaded.wasDismissed('merge:a|b')).toBe(false)
    expect((await reloaded.propose(merge('a', 'b')))?.state).toBe('open')
  })

  it('expires an unanswered suggestion and refuses to act on it', async () => {
    const suggestions = store()
    const first = await suggestions.propose(merge('a', 'b'))
    now += STEWARD_SUGGESTION_TTL_MS
    expect(await suggestions.open()).toEqual([])
    expect((await suggestions.get(first!.id))?.state).toBe('expired')
    await expect(suggestions.dismiss(first!.id)).rejects.toThrow('already expired')
    // An expired pair may be proposed again (it was never dismissed).
    expect((await suggestions.propose(merge('a', 'b')))?.id).not.toBe(first!.id)
  })

  it('replaces the previous couldn’t-place list with the newest one', async () => {
    const suggestions = store()
    const unplaced = (keys: string[]): StewardSuggestionProposal => ({
      kind: 'unplaced',
      targets: keys.map((sessionKey) => ({ sessionKey })),
      proposal: { keys },
      title: `${keys.length} sessions could not be placed`,
      evidence: 'Folder fit below 0.8'
    })
    const older = await suggestions.propose(unplaced(['a', 'b']))
    now += 1000
    const newer = await suggestions.propose(unplaced(['a', 'b', 'c']))
    const open = await suggestions.open('unplaced')
    expect(open.map((entry) => entry.id)).toEqual([newer!.id])
    expect((await suggestions.get(older!.id))?.state).toBe('expired')
  })

  it('writes the file it reads back', async () => {
    const suggestions = store()
    const first = await suggestions.propose(merge('a', 'b'))
    await suggestions.markAccepted(first!.id, 'Merged a into b')
    await suggestions.flush()
    const saved = JSON.parse(await readFile(suggestions.path, 'utf8')) as {
      suggestions: { id: string; state: string; outcome?: string }[]
    }
    expect(saved.suggestions).toEqual([
      expect.objectContaining({ id: first!.id, state: 'accepted', outcome: 'Merged a into b' })
    ])
  })
})
