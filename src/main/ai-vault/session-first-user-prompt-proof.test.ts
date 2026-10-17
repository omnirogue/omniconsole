import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { proveAiVaultFirstUserPrompt } from './session-first-user-prompt-proof'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'omni-first-prompt-proof-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const CODEX_META = {
  timestamp: '2026-09-26T10:00:00.000Z',
  type: 'session_meta',
  payload: { id: 'codex-empty', cwd: '/repo/app' }
}

function codexUserMessage(text: string, second = 1) {
  return {
    timestamp: `2026-09-26T10:00:0${second}.000Z`,
    type: 'event_msg',
    payload: { type: 'user_message', message: text }
  }
}

async function transcript(dir: string, name: string, records: unknown[]): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  return path
}

describe('proveAiVaultFirstUserPrompt', () => {
  it('reads a whole Codex transcript nobody prompted as read, with no prompts', async () => {
    const filePath = await transcript(root, 'rollout-empty.jsonl', [CODEX_META])
    await expect(proveAiVaultFirstUserPrompt({ agent: 'codex', filePath })).resolves.toEqual({
      read: true,
      prompts: [],
      complete: true
    })
  })

  it('returns every user prompt it saw', async () => {
    const filePath = await transcript(root, 'rollout-used.jsonl', [
      CODEX_META,
      codexUserMessage('[from Session steward] Please continue.', 1),
      codexUserMessage('Fix the parser', 2)
    ])
    const proof = await proveAiVaultFirstUserPrompt({ agent: 'codex', filePath })
    expect(proof).toMatchObject({ read: true, complete: true })
    expect(proof.read && proof.prompts).toContain('Fix the parser')
  })

  it('counts a prompt Claude recorded without saving its turn', async () => {
    const sessionId = '9176163a-2f89-431f-b202-32f04d61f124'
    const filePath = await transcript(root, `${sessionId}.jsonl`, [
      { type: 'last-prompt', lastPrompt: 'Run the review', leafUuid: 'leaf-1', sessionId },
      { type: 'mode', mode: 'default', sessionId }
    ])
    const proof = await proveAiVaultFirstUserPrompt({ agent: 'claude', filePath })
    expect(proof.read && proof.prompts).toContain('Run the review')
  })

  it('never reads a damaged, missing, remote, unreadable or unsupported transcript', async () => {
    const corrupt = join(root, 'rollout-corrupt.jsonl')
    await writeFile(corrupt, `${JSON.stringify(CODEX_META)}\n{"type":"event_msg","payl\n`)
    await mkdir(join(root, 'a-directory.jsonl'))
    const empty = await transcript(root, 'rollout-empty.jsonl', [CODEX_META])
    const cases = [
      [{ agent: 'codex', filePath: corrupt }, 'corrupt'],
      [{ agent: 'codex', filePath: join(root, 'gone.jsonl') }, 'missing'],
      [{ agent: 'codex', filePath: empty, executionHostId: 'ssh:devbox' }, 'remote'],
      [{ agent: 'codex', filePath: join(root, 'a-directory.jsonl') }, 'unreadable'],
      [{ agent: 'gemini', filePath: empty }, 'unsupported']
    ] as const
    for (const [args, why] of cases) {
      await expect(proveAiVaultFirstUserPrompt(args as never)).resolves.toEqual({
        read: false,
        why
      })
    }
  })
})
