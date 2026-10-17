import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { AiVaultFirstUserPromptProof } from '../ai-vault/session-first-user-prompt-proof'
import { proveAiVaultFirstUserPrompt } from '../ai-vault/session-first-user-prompt-proof'
import type { FreshPaneStart } from '../agent-hooks/fresh-pane-evidence'
import type { ObservedSession } from '../session-manage/session-manage-observe'
import { agentProcess, sidebarRow } from '../session-manage/session-manage-test-fixtures'
import { stewardPersonPrompted, type StewardPromptedSources } from './steward-prompted-runtime'

const MARKED = '[from Session steward] Please continue.'
const META = {
  timestamp: '2026-09-26T10:00:00.000Z',
  type: 'session_meta',
  payload: { id: 'codex-1', cwd: '/repo/app' }
}
const liveStart: FreshPaneStart = {
  startedAt: 10_000,
  agentPid: 200,
  agent: 'codex',
  restored: false,
  legacy: false,
  connectionId: null,
  launchToken: null
}
const said = (message: string, second: number) => ({
  timestamp: `2026-09-26T10:00:0${second}.000Z`,
  type: 'event_msg',
  payload: { type: 'user_message', message }
})

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'steward-prompted-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function rollout(name: string, records: unknown[]): Promise<string> {
  const path = join(root, name)
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  return path
}

/** The real transcript proof over a Codex pane whose hook reported `hookPrompt`. */
function readPane(
  transcriptPath: string,
  hookPrompt = '',
  row: Partial<SessionManageSidebarRow> = {}
) {
  return stewardPersonPrompted({
    hook: () =>
      ({ prompt: hookPrompt, providerSession: { id: 'codex-1', transcriptPath } }) as ReturnType<
        StewardPromptedSources['hook']
      >,
    prove: (args) => proveAiVaultFirstUserPrompt(args)
  })(sidebarRow({ paneKey: 'p1', agent: 'codex', ...row }))
}

describe('stewardPersonPrompted over real transcripts', () => {
  it('reads none only for a whole, readable transcript nobody prompted', async () => {
    await expect(readPane(await rollout('empty.jsonl', [META]))).resolves.toBe('none')
    const marked = await rollout('marked.jsonl', [META, said(MARKED, 1)])
    await expect(readPane(marked, MARKED)).resolves.toBe('marked')
  })

  it('reads a damaged, missing, remote or unreadable transcript as unknown', async () => {
    const corrupt = join(root, 'corrupt.jsonl')
    await writeFile(corrupt, `${JSON.stringify(META)}\n{"type":"event_msg","payl\n`)
    await mkdir(join(root, 'directory.jsonl'))
    const empty = await rollout('empty.jsonl', [META])
    await expect(readPane(corrupt)).resolves.toBe('unknown')
    await expect(readPane(join(root, 'gone.jsonl'))).resolves.toBe('unknown')
    await expect(readPane(empty, '', { hostId: 'ssh:devbox' })).resolves.toBe('unknown')
    await expect(readPane(join(root, 'directory.jsonl'))).resolves.toBe('unknown')
  })

  it('lets this app run’s hook evidence excuse only a missing transcript', async () => {
    const corrupt = join(root, 'corrupt.jsonl')
    await writeFile(corrupt, `${JSON.stringify(META)}\n{"type":"event_msg","payl\n`)
    const read = (transcriptPath: string) =>
      stewardPersonPrompted({
        hook: () =>
          ({ prompt: '', providerSession: { id: 'codex-1', transcriptPath } }) as ReturnType<
            StewardPromptedSources['hook']
          >,
        prove: (args) => proveAiVaultFirstUserPrompt(args),
        fresh: () => 'untouched',
        freshStart: () => liveStart
      })(sidebarRow({ paneKey: 'p1', agent: 'codex' }))
    await expect(read(join(root, 'gone.jsonl'))).resolves.toBe('untouched')
    await expect(read(corrupt)).resolves.toBe('unknown')
  })

  it('sees a person prompt between marked ones', async () => {
    const path = await rollout('between.jsonl', [
      META,
      said(MARKED, 1),
      said('Also add the migration', 2),
      said(MARKED, 3)
    ])
    await expect(readPane(path, MARKED)).resolves.toBe('person')
  })
})

describe('stewardPersonPrompted', () => {
  const proofOf = (proof: AiVaultFirstUserPromptProof | Error) =>
    stewardPersonPrompted({
      hook: () =>
        ({ prompt: '', providerSession: { id: 's1', transcriptPath: '/t.jsonl' } }) as ReturnType<
          StewardPromptedSources['hook']
        >,
      prove: async () => {
        if (proof instanceof Error) {
          throw proof
        }
        return proof
      }
    })(sidebarRow({ paneKey: 'p1' }))

  it('takes a person prompt from the hook without reading the transcript', async () => {
    const read = stewardPersonPrompted({
      hook: () =>
        ({
          prompt: 'fix the parser',
          providerSession: { id: 's1', transcriptPath: '/t.jsonl' }
        }) as ReturnType<StewardPromptedSources['hook']>,
      prove: () => Promise.reject(new Error('not read'))
    })
    await expect(read(sidebarRow({ paneKey: 'p1' }))).resolves.toBe('person')
  })

  it('reads unknown when the view of its turns is cut, the read fails or the agent is not read', async () => {
    await expect(proofOf({ read: true, prompts: [MARKED], complete: false })).resolves.toBe(
      'unknown'
    )
    await expect(proofOf({ read: true, prompts: ['Fix it'], complete: false })).resolves.toBe(
      'person'
    )
    await expect(proofOf(new Error('service down'))).resolves.toBe('unknown')
    const other = stewardPersonPrompted({
      hook: () => ({ prompt: '' }) as ReturnType<StewardPromptedSources['hook']>,
      prove: async () => ({ read: true, prompts: [], complete: true })
    })
    await expect(other(sidebarRow({ paneKey: 'p1' }))).resolves.toBe('unknown')
    await expect(other(sidebarRow({ paneKey: 'p1', agent: 'aider' }))).resolves.toBe('unknown')
  })
})

describe('stewardPersonPrompted from fresh-start evidence', () => {
  const observed = (overrides: Partial<ObservedSession> = {}) =>
    ({
      terminal: 'term-1',
      facts: { verdict: 'live' },
      agentForeground: true,
      agentProcess: agentProcess({ pid: 200, startTimeMs: 9_000 }),
      ...overrides
    }) as ObservedSession
  const read = (
    start: FreshPaneStart,
    options: {
      agent?: string
      fresh?: 'untouched' | 'touched' | 'unknown'
      prompt?: string
      draft?: boolean
      observed?: ObservedSession
    } = {}
  ) =>
    stewardPersonPrompted({
      hook: () =>
        ({
          prompt: options.prompt ?? '',
          providerSession: { id: 's1', transcriptPath: '/t/s1.jsonl' },
          receivedAt: 10_000,
          agentPid: 200,
          sessionBoundary: true
        }) as ReturnType<StewardPromptedSources['hook']>,
      prove: async () => ({ read: false, why: 'missing' }),
      fresh: () => options.fresh ?? 'untouched',
      freshStart: () => start,
      unresolvedDraft: () => options.draft ?? false
    })(
      sidebarRow({ paneKey: 'p1', agent: options.agent ?? start.agent ?? 'gemini' }),
      options.observed ?? observed()
    )
  const gemini = { ...liveStart, agent: 'gemini' }

  it('reads a Gemini pane nobody touched as untouched, and a marked or touched one not', async () => {
    await expect(read(gemini)).resolves.toBe('untouched')
    await expect(read(gemini, { prompt: MARKED })).resolves.toBe('marked')
    await expect(read(gemini, { fresh: 'touched' })).resolves.toBe('unknown')
    await expect(read(gemini, { draft: true })).resolves.toBe('unknown')
    await expect(read(gemini, { agent: 'kimi' })).resolves.toBe('unknown')
  })

  it('carries a start over a restart only with the same agent process holding its terminal', async () => {
    const restored = { ...gemini, restored: true }
    await expect(read(restored)).resolves.toBe('untouched')
    const moved = [
      observed({ agentProcess: agentProcess({ pid: 201, startTimeMs: 9_000 }) }),
      observed({ agentProcess: agentProcess({ pid: 200, startTimeMs: 60_000 }) }),
      observed({ agentForeground: false }),
      observed({ agentProcess: null })
    ]
    for (const now of moved) {
      await expect(read(restored, { observed: now })).resolves.toBe('unknown')
    }
    // Why: OpenCode's plugin does not spool, so a restart may have hidden its events.
    await expect(read({ ...restored, agent: 'opencode' })).resolves.toBe('unknown')
    // A seed from before the evidence file speaks only through a Claude or Codex transcript.
    await expect(read({ ...restored, legacy: true })).resolves.toBe('unknown')
    await expect(read({ ...restored, agent: 'claude', legacy: true })).resolves.toBe('untouched')
  })
})

describe('stewardPersonPrompted on a connected SSH host', () => {
  const sshStart: FreshPaneStart = {
    ...liveStart,
    agent: 'claude',
    connectionId: 'devbox',
    launchToken: 'launch-1'
  }
  const read = (
    options: {
      minted?: string | null
      unavailable?: boolean
      verdict?: 'live' | 'unverifiable'
      start?: FreshPaneStart
    } = {}
  ) =>
    stewardPersonPrompted({
      hook: () =>
        ({
          prompt: '',
          providerSession: { id: 's1', transcriptPath: '/remote/s1.jsonl' },
          receivedAt: 10_000,
          sessionBoundary: true
        }) as ReturnType<StewardPromptedSources['hook']>,
      prove: () => Promise.reject(new Error('an SSH transcript is never read here')),
      fresh: () => 'untouched',
      freshStart: () => options.start ?? sshStart,
      launchToken: () => (options.minted === undefined ? 'launch-1' : options.minted)
    })(
      sidebarRow({
        paneKey: 'p1',
        agent: 'claude',
        hostId: 'ssh:devbox',
        hostUnavailable: options.unavailable ?? false
      }),
      { terminal: 'term-1', facts: { verdict: options.verdict ?? 'live' } } as ObservedSession
    )

  it('reads untouched only for an agent this app run launched through the relay', async () => {
    await expect(read()).resolves.toBe('untouched')
    // An adopted or reattached PTY has no launch this run minted; another launch is not it.
    await expect(read({ minted: null })).resolves.toBe('unknown')
    await expect(read({ minted: 'launch-2' })).resolves.toBe('unknown')
    await expect(read({ start: { ...sshStart, connectionId: 'otherbox' } })).resolves.toBe(
      'unknown'
    )
  })

  it('reads unknown while its host is unreachable or its pane unverified', async () => {
    await expect(read({ unavailable: true })).resolves.toBe('unknown')
    await expect(read({ verdict: 'unverifiable' })).resolves.toBe('unknown')
  })
})
