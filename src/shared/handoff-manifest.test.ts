import { describe, expect, it } from 'vitest'
import {
  HANDOFF_MEMO_MAX_BYTES,
  buildHandoffManifest,
  clampHandoffMemo,
  handoffMemoLines,
  isSafeRelativePath,
  parseHandoffManifest,
  serializeHandoffManifest
} from './handoff-manifest'

const sha = 'a'.repeat(64)

function manifest() {
  return buildHandoffManifest({
    createdAt: new Date('2026-09-14T12:00:00Z'),
    source: {
      sessionLabel: 'Research the seedance lander',
      chainId: 'chn_1',
      stepId: 'step_1_x'
    },
    git: {
      repo: 'omnirogue/omni-ide',
      branch: 'handoff/chn_1',
      sha: 'abcdef1234567',
      baseBranch: 'main-next'
    },
    trail: { ledgerUrl: 'https://app.omnisi.ai/?ledger=ldg_1' },
    memo: 'Take it from here.',
    files: [
      {
        rel: 'docs/plan.md',
        name: 'plan.md',
        route: 'git',
        sha256: sha,
        size: 12
      },
      {
        rel: 'brief.pdf',
        name: 'brief.pdf',
        route: 'pin',
        sha256: sha,
        size: 3,
        taskPath: 'uploads/brief.pdf'
      },
      {
        rel: 'renders/big.mov',
        name: 'big.mov',
        route: 'card',
        sha256: sha,
        size: 20,
        deliveryId: 'dlv_1'
      }
    ]
  })
}

describe('handoff manifest', () => {
  it('round-trips through its serialized form', () => {
    const built = manifest()
    const text = serializeHandoffManifest(built)
    expect(text.endsWith('\n')).toBe(true)
    expect(parseHandoffManifest(text)).toEqual(built)
  })

  it('refuses unknown versions, unsafe paths and malformed digests', () => {
    const built = manifest()
    expect(parseHandoffManifest(JSON.stringify({ ...built, version: 2 }))).toBeNull()
    expect(
      parseHandoffManifest(
        JSON.stringify({
          ...built,
          files: [{ ...built.files[0], rel: '../escape.md' }]
        })
      )
    ).toBeNull()
    expect(
      parseHandoffManifest(
        JSON.stringify({
          ...built,
          files: [{ ...built.files[0], sha256: 'xyz' }]
        })
      )
    ).toBeNull()
    expect(parseHandoffManifest('not json')).toBeNull()
  })

  it('keeps relative paths inside the folder', () => {
    expect(isSafeRelativePath('docs/plan.md')).toBe(true)
    expect(isSafeRelativePath('a\\b\\c.txt')).toBe(true)
    expect(isSafeRelativePath('/etc/passwd')).toBe(false)
    expect(isSafeRelativePath('C:\\Windows\\x')).toBe(false)
    expect(isSafeRelativePath('a/../b')).toBe(false)
    expect(isSafeRelativePath('a//b')).toBe(false)
    expect(isSafeRelativePath('./a')).toBe(false)
    expect(isSafeRelativePath('')).toBe(false)
  })

  it('clamps the memo to the 4 KB budget on a character boundary', () => {
    const long = 'é'.repeat(5000)
    const clamped = clampHandoffMemo(long)
    expect(new TextEncoder().encode(clamped).length).toBeLessThanOrEqual(HANDOFF_MEMO_MAX_BYTES)
    expect(clamped.endsWith('…')).toBe(true)
    expect(clampHandoffMemo('short')).toBe('short')
  })

  it('summarizes the routes and trail for the memo', () => {
    expect(handoffMemoLines(manifest())).toEqual([
      'Branch: handoff/chn_1 @ abcdef123456 (omnirogue/omni-ide)',
      'Trail: https://app.omnisi.ai/?ledger=ldg_1',
      'Files: 1 by git, 1 on the thread, 1 on the card (see handoff-manifest.json)'
    ])
    expect(handoffMemoLines({ files: [] })).toEqual([])
  })
})
