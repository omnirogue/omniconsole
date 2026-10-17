import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import {
  buildStewardResultCard,
  STEWARD_RESULT_REPLY_MAX,
  StewardResultCardStore
} from './steward-result-card'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'steward-cards-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const chain = {
  outcomeSet: {
    outcomes: [
      {
        evidence: [
          {
            kind: 'merge',
            target: 'https://github.com/acme/app/pull/12',
            receipt: 'verified:merge',
            verifiedAt: 5
          }
        ]
      }
    ]
  }
} as unknown as SessionChain

function card(overrides: Partial<Parameters<typeof buildStewardResultCard>[0]> = {}) {
  return buildStewardResultCard({
    key: 'view-1',
    paneKey: 'tab-1:leaf-1',
    title: 'Checkout fix',
    goal: 'Fix the checkout total',
    reply:
      'Opened https://github.com/acme/app/pull/12 and the preview is at https://checkout-git-fix.vercel.app.',
    changed: { files: ['src/checkout.ts'], branch: 'fix/total' },
    chains: [chain],
    linkedDocs: [
      { kind: 'slite', id: 'abcdef12', url: 'https://acme.slite.com/app/docs/abcdef12', seenAt: 1 }
    ],
    evidence: 'JEV resolved 0.91 · quiet 7 h',
    now: 42,
    ...overrides
  })
}

describe('the result card', () => {
  it('holds the reply, pull requests, changed files, receipts and links, with no model', () => {
    expect(card()).toEqual({
      key: 'view-1',
      paneKey: 'tab-1:leaf-1',
      title: 'Checkout fix',
      goal: 'Fix the checkout total',
      lastReply:
        'Opened https://github.com/acme/app/pull/12 and the preview is at https://checkout-git-fix.vercel.app.',
      pullRequests: [
        { owner: 'acme', repo: 'app', number: 12, url: 'https://github.com/acme/app/pull/12' }
      ],
      changedFiles: ['src/checkout.ts'],
      branch: 'fix/total',
      outcomeReceipts: [
        {
          kind: 'merge',
          target: 'https://github.com/acme/app/pull/12',
          receipt: 'verified:merge',
          verifiedAt: 5
        }
      ],
      artifacts: [
        { url: 'https://acme.slite.com/app/docs/abcdef12', kind: 'slite' },
        { url: 'https://checkout-git-fix.vercel.app', kind: 'preview' }
      ],
      evidence: 'JEV resolved 0.91 · quiet 7 h',
      builtAt: 42
    })
  })

  it('keeps only the end of a long reply, and GitHub’s facts when it read them', () => {
    const built = card({
      reply: `${'x'.repeat(STEWARD_RESULT_REPLY_MAX)} end https://github.com/acme/app/pull/12`,
      pullRequestFacts: [
        {
          owner: 'acme',
          repo: 'app',
          number: 12,
          url: 'https://github.com/acme/app/pull/12',
          title: 'Fix the total',
          state: 'merged'
        } as never
      ]
    })
    expect(built.lastReply.startsWith('…')).toBe(true)
    expect(built.lastReply.endsWith('pull/12')).toBe(true)
    expect(built.pullRequests).toEqual([
      {
        owner: 'acme',
        repo: 'app',
        number: 12,
        url: 'https://github.com/acme/app/pull/12',
        title: 'Fix the total',
        state: 'merged'
      }
    ])
  })

  it('is saved per session, replaced by a later one, and listed newest first', async () => {
    const store = new StewardResultCardStore(dir)
    await store.save(card({ key: 'a', now: 1 }))
    await store.save(card({ key: 'b', now: 2 }))
    await store.save(card({ key: 'a', now: 3, title: 'Again' }))
    expect(store.read('a')).toMatchObject({ title: 'Again', builtAt: 3 })
    expect(store.list().map((entry) => entry.key)).toEqual(['a', 'b'])
    expect(store.read('missing')).toBeNull()
  })
})
