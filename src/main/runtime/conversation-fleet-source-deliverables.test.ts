import { posix } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HANDOFF_FILE_MAX_BYTES } from '../../shared/console-handoff-contract'
import { FLEET_SOURCE_MAX_FILES } from '../../shared/conversation-fleet-source-snapshot'
import type { SessionFollowUpDeliverables } from '../../shared/session-follow-up-rule-fields'
import { captureFleetSourceDeliverables } from './conversation-fleet-source-deliverables'
import type { FleetSourceIo, SourceStat } from './conversation-fleet-source-io'

const root = '/workspace'
function fixture(contents: Record<string, string | Buffer> = {}, sourceWorkspacePath?: string) {
  const stats = new Map<string, SourceStat>([[root, { type: 'directory', size: 0, mtimeMs: 1 }]])
  const bytes = new Map<string, Buffer>()
  for (const [relative, value] of Object.entries(contents)) {
    const path = posix.join(root, relative)
    const content = Buffer.isBuffer(value) ? value : Buffer.from(value)
    bytes.set(path, content)
    stats.set(path, { type: 'file', size: content.length, mtimeMs: 2, mode: 0o100644 })
    for (let parent = posix.dirname(path); parent !== '/'; parent = posix.dirname(parent)) {
      stats.set(parent, { type: 'directory', size: 0, mtimeMs: 1 })
    }
  }
  const io = {
    realpath: vi.fn(async (path: string) => path),
    lstat: vi.fn(async (path: string) => {
      const stat = stats.get(path)
      if (!stat) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      }
      return stat
    }),
    readExact: vi.fn(async (path: string, _max: number, _expected?: SourceStat) => {
      const content = bytes.get(path)
      if (!content) {
        throw new Error(`Unexpected read: ${path}`)
      }
      return content
    })
  } satisfies FleetSourceIo
  const relativePath = vi.fn((input: string) => {
    const inputRoot =
      sourceWorkspacePath && input.startsWith(`${sourceWorkspacePath}/`)
        ? sourceWorkspacePath
        : root
    const relative = posix.isAbsolute(input) ? posix.relative(inputRoot, input) : input
    if (!relative || relative.split('/').includes('..')) {
      throw new Error('Select a file inside the workspace.')
    }
    return relative
  })
  const capture = (deliverables?: SessionFollowUpDeliverables, signal?: AbortSignal) =>
    captureFleetSourceDeliverables({
      io,
      root,
      sourceWorkspacePath,
      deliverables,
      relativePath,
      signal
    })
  return { io, bytes, stats, relativePath, capture }
}

describe('fleet deliverable capture', () => {
  it('keeps absent deliverables empty and normalizes only explicitly selected files', async () => {
    const { capture, io } = fixture()
    expect(await capture()).toEqual({ paths: new Set(), manifests: new Map() })
    const result = await capture({
      kind: 'files',
      paths: ['/workspace/out/report.pdf', 'out/report.pdf', '.env']
    })
    expect(result.paths).toEqual(new Set(['out/report.pdf', '.env']))
    expect(result.deliverables).toEqual({ kind: 'files', paths: ['out/report.pdf', '.env'] })
    expect(io.lstat).not.toHaveBeenCalled()
    await expect(capture({ kind: 'files', paths: ['/elsewhere/file.txt'] })).rejects.toThrow(
      'inside'
    )
  })

  it('pins exact manifest bytes and identity, retaining only its listed files without recursion', async () => {
    const manifest = Buffer.from('\uFEFF# Outputs\r\n- `résumé.pdf`\r\n- nested.md\r\n- .env\r\n')
    const { capture, io, stats } = fixture({
      'out/manifest.md': manifest,
      'out/nested.md': '- unrelated.txt',
      'out/unrelated.txt': 'never requested'
    })
    const result = await capture({ kind: 'manifest', manifestPath: '/workspace/out/manifest.md' })
    expect(result.paths).toEqual(
      new Set(['out/manifest.md', 'out/résumé.pdf', 'out/nested.md', 'out/.env'])
    )
    expect(result.deliverables).toEqual({ kind: 'manifest', manifestPath: 'out/manifest.md' })
    expect(result.manifests.get('out/manifest.md')).toEqual({
      stat: stats.get('/workspace/out/manifest.md'),
      bytes: manifest
    })
    expect(io.readExact).toHaveBeenCalledExactlyOnceWith(
      '/workspace/out/manifest.md',
      HANDOFF_FILE_MAX_BYTES,
      stats.get('/workspace/out/manifest.md')
    )
    expect(io.lstat.mock.calls.every(([path]) => !path.includes('nested'))).toBe(true)
  })

  it('deduplicates explicit manifests and shared outputs without changing the rule kind', async () => {
    const { capture, io } = fixture({ 'a.md': '- shared.pdf\n- b.md', 'b.md': '- shared.pdf' })
    const result = await capture({
      kind: 'manifests',
      manifestPaths: ['/workspace/a.md', 'a.md', 'b.md']
    })
    expect(result.paths).toEqual(new Set(['a.md', 'b.md', 'shared.pdf']))
    expect(result.deliverables).toEqual({ kind: 'manifests', manifestPaths: ['a.md', 'b.md'] })
    expect([...result.manifests.keys()]).toEqual(['a.md', 'b.md'])
    expect(io.readExact).toHaveBeenCalledTimes(2)
  })

  it('accepts only canonical and registered source aliases while reading the canonical host path', async () => {
    const sourceWorkspacePath = '/registered-workspace'
    const { capture, io } = fixture(
      {
        'out/manifest.md': [
          '- /registered-workspace/out/report.pdf',
          '- /workspace/out/report.pdf',
          '- /registered-workspace/out/manifest.md',
          '- relative.txt'
        ].join('\n')
      },
      sourceWorkspacePath
    )
    const result = await capture({
      kind: 'manifest',
      manifestPath: '/registered-workspace/out/manifest.md'
    })
    expect(result.paths).toEqual(new Set(['out/manifest.md', 'out/report.pdf', 'out/relative.txt']))
    expect(result.deliverables).toEqual({ kind: 'manifest', manifestPath: 'out/manifest.md' })
    expect(io.lstat.mock.calls.every(([path]) => path.startsWith(root))).toBe(true)
    expect(io.readExact.mock.calls.map(([path]) => path)).toEqual(['/workspace/out/manifest.md'])
    for (const path of ['/outside/private.txt', '/registered-workspace-other/private.txt']) {
      const invalid = fixture({ 'manifest.md': `- ${path}` }, sourceWorkspacePath)
      await expect(
        invalid.capture({ kind: 'manifest', manifestPath: 'manifest.md' })
      ).rejects.toThrow('outside')
    }
  })

  it.each(['- /outside/private.txt', '- ../private.txt', '- /workspace-other/private.txt'])(
    'rejects out-of-workspace manifest entries: %s',
    async (markdown) => {
      const { capture, io } = fixture({ 'manifest.md': markdown })
      await expect(capture({ kind: 'manifest', manifestPath: 'manifest.md' })).rejects.toThrow(
        'outside'
      )
      expect(io.lstat.mock.calls.every(([path]) => path.startsWith(root))).toBe(true)
    }
  )

  it('rejects symlink manifests and nonregular manifests before reading', async () => {
    const { capture, io, stats } = fixture({ 'manifest.md': '' })
    stats.set('/workspace/manifest.md', { type: 'symlink', size: 0, mtimeMs: 1 })
    await expect(capture({ kind: 'manifest', manifestPath: 'manifest.md' })).rejects.toThrow(
      'symlink'
    )
    stats.set('/workspace/manifest.md', { type: 'directory', size: 0, mtimeMs: 1 })
    await expect(capture({ kind: 'manifest', manifestPath: 'manifest.md' })).rejects.toThrow(
      'regular'
    )
    expect(io.readExact).not.toHaveBeenCalled()
  })

  it('refuses invalid UTF-8 and incomplete exact reads', async () => {
    const { capture, io } = fixture({ 'manifest.md': Buffer.from([0xc3, 0x28]) })
    await expect(capture({ kind: 'manifest', manifestPath: 'manifest.md' })).rejects.toThrow(
      'UTF-8'
    )
    io.readExact.mockResolvedValue(Buffer.alloc(0))
    await expect(capture({ kind: 'manifest', manifestPath: 'manifest.md' })).rejects.toThrow(
      'changed size'
    )
  })

  it('counts the manifest and unique declared files toward the dispatch limit', async () => {
    const listed = Array.from({ length: FLEET_SOURCE_MAX_FILES - 1 }, (_, i) => `- ${i}.txt`)
    const { capture, bytes, stats } = fixture({ 'manifest.md': [...listed, ...listed].join('\n') })
    const accepted = await capture({ kind: 'manifest', manifestPath: 'manifest.md' })
    expect(accepted.paths.size).toBe(FLEET_SOURCE_MAX_FILES)
    const tooMany = Buffer.from([...listed, '- extra.txt'].join('\n'))
    bytes.set('/workspace/manifest.md', tooMany)
    stats.get('/workspace/manifest.md')!.size = tooMany.length
    await expect(capture({ kind: 'manifest', manifestPath: 'manifest.md' })).rejects.toThrow(
      'at most 30'
    )
    await expect(
      capture({
        kind: 'files',
        paths: Array.from({ length: FLEET_SOURCE_MAX_FILES + 1 }, (_, i) => `${i}.txt`)
      })
    ).rejects.toThrow('at most 30')
  })

  it('rejects oversized manifests and aggregate manifest bytes before any content read', async () => {
    const { capture, io, stats } = fixture({ 'a.md': '', 'b.md': '', 'c.md': '', 'd.md': '' })
    stats.get('/workspace/a.md')!.size = HANDOFF_FILE_MAX_BYTES + 1
    await expect(capture({ kind: 'manifest', manifestPath: 'a.md' })).rejects.toThrow('10 MiB')
    for (const [path, stat] of stats) {
      if (path.endsWith('.md')) {
        stat.size = HANDOFF_FILE_MAX_BYTES
      }
    }
    await expect(
      capture({ kind: 'manifests', manifestPaths: ['a.md', 'b.md', 'c.md', 'd.md'] })
    ).rejects.toThrow('32 MiB')
    expect(io.readExact).not.toHaveBeenCalled()
  })

  it('honors cancellation before accessing the source host', async () => {
    const { capture, io } = fixture({ 'manifest.md': '' })
    const controller = new AbortController()
    controller.abort(new Error('Dispatch cancelled'))
    await expect(
      capture({ kind: 'manifest', manifestPath: 'manifest.md' }, controller.signal)
    ).rejects.toThrow('Dispatch cancelled')
    expect(io.lstat).not.toHaveBeenCalled()
  })
})
