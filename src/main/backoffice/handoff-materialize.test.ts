import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildHandoffManifest, HANDOFF_MANIFEST_NAME } from '../../shared/handoff-manifest'
import {
  HandoffMaterializeError,
  attachmentsManifest,
  defaultMaterializeRoot,
  materializeHandoffFiles,
  readHandoffManifestFile,
  resolveUnderRoot
} from './handoff-materialize'

function exact(name: string, text: string) {
  const bytes = Buffer.from(text, 'utf8')
  return {
    name,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    contentBase64: bytes.toString('base64')
  }
}

const brief = exact('brief.pdf', 'the brief bytes')
const notes = exact('notes.md', '# notes\n')
const tracked = exact('plan.md', 'tracked by git')

function manifest() {
  return buildHandoffManifest({
    createdAt: new Date('2026-09-14T12:00:00Z'),
    source: { sessionLabel: 'Seedance lander' },
    git: {
      repo: 'omnirogue/omni-ide',
      branch: 'handoff/chn_1',
      sha: 'abcdef1234567'
    },
    memo: 'Take it from here.',
    files: [
      {
        rel: 'docs/plan.md',
        name: 'plan.md',
        route: 'git',
        sha256: tracked.sha256,
        size: tracked.size
      },
      {
        rel: 'inputs/brief.pdf',
        name: 'brief.pdf',
        route: 'pin',
        sha256: brief.sha256,
        size: brief.size
      },
      {
        rel: 'notes.md',
        name: 'notes.md',
        route: 'card',
        sha256: notes.sha256,
        size: notes.size
      }
    ]
  })
}

const threadFiles = [
  {
    id: 'hfv_1',
    name: 'brief.pdf',
    sha256: brief.sha256,
    rel: 'uploads/brief.pdf'
  },
  {
    id: 'hfv_2',
    name: 'notes.md',
    sha256: notes.sha256,
    rel: 'uploads/notes.md'
  }
]

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omni-materialize-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('a request sent as plain attachments', () => {
  // Every Person request is one: found live 2026-09-18, "Save files…" and "Continue with AI" both
  // refused thread hth_bd4d2957be304081bad4 with "carries no handoff-manifest.json".
  it('is saved side by side into the chosen folder, with no manifest on the thread', async () => {
    const summary = exact('Summary - Write ads - 2026-09-18 130924.md', '# Summary\n')
    const sent = [
      { id: 'hfv_1', ...brief },
      { id: 'hfv_2', ...summary },
      { id: 'hfv_3', ...exact('../escape.md', 'never written') }
    ]
    const flat = attachmentsManifest('Review: write ads', sent)
    expect(flat.files.map((file) => [file.rel, file.route])).toEqual([
      ['brief.pdf', 'pin'],
      ['Summary - Write ads - 2026-09-18 130924.md', 'pin']
    ])
    const download = vi
      .fn()
      .mockImplementation(async ({ id }: { id: string }) => (id === 'hfv_1' ? brief : summary))
    const result = await materializeHandoffFiles({
      root,
      manifest: flat,
      threadFiles: sent,
      io: { download }
    })
    expect(result.complete).toBe(true)
    expect(result.files.map((file) => [file.name, file.outcome])).toEqual([
      ['brief.pdf', 'written'],
      ['Summary - Write ads - 2026-09-18 130924.md', 'written']
    ])
    expect(readFileSync(join(root, 'brief.pdf'), 'utf8')).toBe('the brief bytes')
    expect(defaultMaterializeRoot(root, flat)).toBe(root)
  })
})

describe('materializeHandoffFiles', () => {
  it('writes each file into the folder the sender had it in and skips git-borne files', async () => {
    const download = vi
      .fn()
      .mockImplementation(async ({ id }: { id: string }) => (id === 'hfv_1' ? brief : notes))

    const result = await materializeHandoffFiles({
      root,
      manifest: manifest(),
      threadFiles,
      io: { download }
    })

    expect(result.complete).toBe(true)
    expect(result.files.map((file) => [file.rel, file.outcome])).toEqual([
      ['inputs/brief.pdf', 'written'],
      ['notes.md', 'written']
    ])
    expect(readFileSync(join(root, 'inputs', 'brief.pdf'), 'utf8')).toBe('the brief bytes')
    expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('# notes\n')
    // The git-borne file is the checkout's job; nothing downloads or writes it.
    expect(existsSync(join(root, 'docs', 'plan.md'))).toBe(false)
    expect(download).toHaveBeenCalledTimes(2)
  })

  it('leaves a file that is already there with the same bytes alone', async () => {
    const download = vi.fn().mockResolvedValue(brief)
    mkdirSync(join(root, 'inputs'), { recursive: true })
    writeFileSync(join(root, 'inputs', 'brief.pdf'), 'the brief bytes')
    writeFileSync(join(root, 'notes.md'), '# notes\n')

    const result = await materializeHandoffFiles({
      root,
      manifest: manifest(),
      threadFiles,
      io: { download }
    })

    expect(result.files.every((file) => file.outcome === 'unchanged')).toBe(true)
    expect(download).not.toHaveBeenCalled()
  })

  it('preserves different recipient work and still materializes independent files', async () => {
    mkdirSync(join(root, 'inputs'), { recursive: true })
    writeFileSync(join(root, 'inputs', 'brief.pdf'), 'recipient edits')
    const download = vi.fn().mockResolvedValue(notes)
    const result = await materializeHandoffFiles({
      root,
      manifest: manifest(),
      threadFiles,
      io: { download }
    })
    expect(result.complete).toBe(false)
    expect(result.files[0]).toMatchObject({
      outcome: 'refused',
      reason: expect.stringContaining('already contains different work')
    })
    expect(readFileSync(join(root, 'inputs', 'brief.pdf'), 'utf8')).toBe('recipient edits')
    expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('# notes\n')
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('does not overwrite a destination created while its download was in flight', async () => {
    const download = vi.fn().mockImplementation(async ({ id }: { id: string }) => {
      if (id === 'hfv_1') {
        mkdirSync(join(root, 'inputs'), { recursive: true })
        writeFileSync(join(root, 'inputs', 'brief.pdf'), 'concurrent recipient work')
        return brief
      }
      return notes
    })
    const result = await materializeHandoffFiles({
      root,
      manifest: manifest(),
      threadFiles,
      io: { download }
    })
    expect(result.complete).toBe(false)
    expect(result.files[0]).toMatchObject({
      outcome: 'refused',
      reason: expect.stringContaining('Cannot write')
    })
    expect(readFileSync(join(root, 'inputs', 'brief.pdf'), 'utf8')).toBe(
      'concurrent recipient work'
    )
    expect(result.files[1]?.outcome).toBe('written')
  })

  it('refuses bytes that do not match the version the sender recorded', async () => {
    const tampered = {
      ...brief,
      contentBase64: Buffer.from('other bytes').toString('base64')
    }
    const download = vi
      .fn()
      .mockImplementation(async ({ id }: { id: string }) => (id === 'hfv_1' ? tampered : notes))

    const result = await materializeHandoffFiles({
      root,
      manifest: manifest(),
      threadFiles,
      io: { download }
    })

    expect(result.complete).toBe(false)
    expect(result.files[0]).toMatchObject({
      outcome: 'refused',
      reason: expect.stringContaining('does not match the version the sender recorded')
    })
    expect(existsSync(join(root, 'inputs', 'brief.pdf'))).toBe(false)
  })

  it('refuses a manifest entry no file on the thread answers', async () => {
    const result = await materializeHandoffFiles({
      root,
      manifest: manifest(),
      threadFiles: [threadFiles[0]!],
      io: { download: vi.fn().mockResolvedValue(brief) }
    })

    expect(result.complete).toBe(false)
    expect(result.files[1]).toMatchObject({
      outcome: 'refused',
      reason: expect.stringContaining('not on this handoff')
    })
  })

  it('never writes outside the chosen folder', async () => {
    expect(() => resolveUnderRoot(root, '../escape.txt')).toThrow(HandoffMaterializeError)
    expect(() => resolveUnderRoot(root, '/etc/passwd')).toThrow(HandoffMaterializeError)
    expect(resolveUnderRoot(root, 'a/b.txt')).toBe(join(root, 'a', 'b.txt'))
    // A sibling directory whose name merely starts with the root's is still outside it.
    expect(() => resolveUnderRoot(join(root, 'work'), '../work-other/x')).toThrow(
      HandoffMaterializeError
    )
  })
})

describe('readHandoffManifestFile', () => {
  it('reads and validates the manifest that travels as the first file', async () => {
    const built = manifest()
    const bytes = Buffer.from(`${JSON.stringify(built, null, 2)}\n`, 'utf8')
    const download = vi.fn().mockResolvedValue({
      name: HANDOFF_MANIFEST_NAME,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      contentBase64: bytes.toString('base64')
    })

    await expect(
      readHandoffManifestFile([{ id: 'hfv_0', name: HANDOFF_MANIFEST_NAME }], download)
    ).resolves.toEqual(built)
  })

  it('says plainly when a handoff carries no manifest or an unreadable one', async () => {
    await expect(readHandoffManifestFile([], vi.fn())).rejects.toMatchObject({
      code: 'manifest_unreadable'
    })
    const junk = Buffer.from('not json')
    await expect(
      readHandoffManifestFile(
        [{ id: 'hfv_0', name: HANDOFF_MANIFEST_NAME }],
        vi.fn().mockResolvedValue({
          name: HANDOFF_MANIFEST_NAME,
          size: junk.length,
          sha256: createHash('sha256').update(junk).digest('hex'),
          contentBase64: junk.toString('base64')
        })
      )
    ).rejects.toMatchObject({ code: 'manifest_unreadable' })
  })
})

describe('defaultMaterializeRoot', () => {
  it('keeps non-repo files out of the way of a checkout', () => {
    expect(defaultMaterializeRoot('/w', manifest())).toBe(
      join('/w', '.omni', 'handoffs', 'abcdef123456')
    )
  })

  it('uses the workspace itself when no branch travelled', () => {
    const noGit = buildHandoffManifest({
      createdAt: new Date('2026-09-14T12:00:00Z'),
      source: { sessionLabel: 'x' },
      memo: 'm',
      files: []
    })
    expect(defaultMaterializeRoot('/w', noGit)).toBe('/w')
  })
})
