import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { purgeConversationTranscripts } from './artifact-review-transcript-purge'
import { worktreeCreatedForPane } from './artifact-review-workspace-purge'

const ID = '0f0e0d0c-0b0a-4908-8706-050403020100'
const OTHER = '11111111-2222-4333-8444-555555555555'
let home = ''

function file(path: string, text = '{}\n'): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
  return path
}

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('transcript purge on reject', () => {
  it('removes every copy of a Claude conversation with its folder and session env, nothing else', async () => {
    home = mkdtempSync(join(tmpdir(), 'review-purge-'))
    const main = file(join(home, '.claude', 'projects', '-w', `${ID}.jsonl`))
    const sub = file(join(home, '.claude', 'projects', '-w', ID, 'subagents', 'a.jsonl'))
    const env = file(join(home, '.claude', 'session-env', ID, 'env.sh'))
    const pooled = file(join(home, '.claude-accounts', 'pool', 'projects', '-w', `${ID}.jsonl`))
    const keep = file(join(home, '.claude', 'projects', '-w', `${OTHER}.jsonl`))
    const purge = await purgeConversationTranscripts('claude', ID, {
      userDataPath: join(home, 'ud'),
      homeDir: home
    })
    expect(purge.failed).toEqual([])
    for (const gone of [main, sub, env, pooled]) {
      expect(existsSync(gone)).toBe(false)
    }
    expect(existsSync(keep)).toBe(true)
  })

  it('removes every hard link of a Codex rollout and its index lines', async () => {
    home = mkdtempSync(join(tmpdir(), 'review-purge-'))
    const rollout = file(
      join(
        home,
        '.codex',
        'sessions',
        '2026',
        '10',
        '04',
        `rollout-2026-10-04T10-00-00-${ID}.jsonl`
      )
    )
    const alias = join(
      home,
      '.codex-work',
      'sessions',
      '2026',
      '10',
      '04',
      `rollout-2026-10-04T10-00-00-${ID}.jsonl`
    )
    mkdirSync(join(alias, '..'), { recursive: true })
    linkSync(rollout, alias)
    const index = file(
      join(home, '.codex', 'session_index.jsonl'),
      `{"id":"${ID}"}\n{"id":"${OTHER}"}\n`
    )
    await purgeConversationTranscripts('codex', ID, {
      userDataPath: join(home, 'ud'),
      homeDir: home
    })
    expect(existsSync(rollout)).toBe(false)
    expect(existsSync(alias)).toBe(false)
    expect(readFileSync(index, 'utf8')).toBe(`{"id":"${OTHER}"}\n`)
  })

  it('also removes the recorded transcript Claude named differently, and archived Codex rollouts', async () => {
    home = mkdtempSync(join(tmpdir(), 'review-purge-'))
    const renamed = file(join(home, '.claude', 'projects', '-w', `${OTHER}.jsonl`))
    await purgeConversationTranscripts('claude', ID, {
      userDataPath: join(home, 'ud'),
      homeDir: home,
      transcriptPath: renamed
    })
    expect(existsSync(renamed)).toBe(false)
    const archived = file(
      join(home, '.codex', 'archived_sessions', `rollout-2026-10-04T10-00-00-${ID}.jsonl`)
    )
    file(join(home, '.codex', 'sessions', 'x.jsonl'))
    const index = file(
      join(home, '.codex', 'session_index.jsonl'),
      `{"id":"${ID}"}\n{"id":"${OTHER}","note":"${ID}"}\n`
    )
    await purgeConversationTranscripts('codex', ID, {
      userDataPath: join(home, 'ud'),
      homeDir: home
    })
    expect(existsSync(archived)).toBe(false)
    expect(readFileSync(index, 'utf8')).toBe(`{"id":"${OTHER}","note":"${ID}"}\n`)
  })

  it('never removes a recorded path outside the known roots', async () => {
    home = mkdtempSync(join(tmpdir(), 'review-purge-'))
    const outside = file(join(home, 'notes', `${ID}.jsonl`))
    await purgeConversationTranscripts('claude', ID, {
      userDataPath: join(home, 'ud'),
      homeDir: home,
      transcriptPath: outside
    })
    expect(existsSync(outside)).toBe(true)
  })

  it('refuses an id that is not a provider session id', async () => {
    home = mkdtempSync(join(tmpdir(), 'review-purge-'))
    expect(
      (await purgeConversationTranscripts('claude', '../x', { userDataPath: home, homeDir: home }))
        .failed
    ).toHaveLength(1)
  })
})

describe('worktree created for the session', () => {
  it('is proven only by a launch record that created it for this exact pane', async () => {
    home = mkdtempSync(join(tmpdir(), 'review-purge-'))
    file(
      join(home, 'agent-launch-operations', '1.json'),
      JSON.stringify({
        placement: { createdWorktreeId: 'r::/w' },
        terminal: { paneKey: 'tab-1:leaf-1' }
      })
    )
    expect(await worktreeCreatedForPane(home, 'r::/w', 'tab-1:leaf-1')).toBe(true)
    expect(await worktreeCreatedForPane(home, 'r::/w', 'tab-2:leaf-1')).toBe(false)
    expect(await worktreeCreatedForPane(join(home, 'none'), 'r::/w', 'tab-1:leaf-1')).toBe(false)
  })
})
