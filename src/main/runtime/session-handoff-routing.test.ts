import { beforeEach, expect, it, vi } from 'vitest'
import type { SessionFollowUpRule } from '../../shared/session-follow-up-rule'
import { prepareHandoffRoutes } from '../backoffice/handoff-route-prepare'
import { applySessionHandoffRouting } from './session-handoff-routing'

vi.mock('../backoffice/handoff-route-prepare', () => ({ prepareHandoffRoutes: vi.fn() }))

const pins = [
  { sourcePath: '/w/plan.md', name: 'plan.md', sha256: 'a'.repeat(64), size: 10 },
  { sourcePath: '/w/build/brief.pdf', name: 'brief.pdf', sha256: 'b'.repeat(64), size: 20 }
]
const manifest = {
  sourcePath: '/w/.omni/handoffs/handoff-chain/handoff-manifest.json',
  name: 'handoff-manifest.json',
  sha256: 'c'.repeat(64),
  size: 30
}
function rule(patch: Partial<SessionFollowUpRule> = {}): SessionFollowUpRule {
  return {
    includeWorkingTree: true,
    revision: 1,
    taskId: null,
    taskTitle: 'Review work',
    sessionLabel: 'Work',
    recipients: [],
    deliverables: { kind: 'files', paths: pins.map((pin) => pin.sourcePath) },
    includeSummary: false,
    note: 'Please review.',
    savedAt: 1,
    files: pins,
    ...patch
  }
}
beforeEach(() => vi.mocked(prepareHandoffRoutes).mockReset())

it('explicitly hands over the working tree and keeps ordinary attachments beside the manifest', async () => {
  vi.mocked(prepareHandoffRoutes).mockResolvedValue({
    ok: true,
    data: {
      git: {
        repo: 'org/repo',
        branch: 'handoff/chain',
        sha: 'abc',
        baseBranch: null,
        remote: 'origin'
      },
      pins: [manifest],
      memoLines: ['Branch: handoff/chain @ abc'],
      refused: [],
      manifest: []
    }
  })
  const original = rule({ request: { title: 'Review', description: 'The final answer.' } })
  const next = await applySessionHandoffRouting(original, '/w', 'chain')
  expect(prepareHandoffRoutes).toHaveBeenCalledExactlyOnceWith({
    workspacePath: '/w',
    branch: 'handoff/chain',
    label: 'Review work',
    memo: 'Please review.',
    pins: [],
    next: 'person',
    sameWorktree: false,
    includeWorkingTree: true
  })
  expect(next.files).toEqual([...pins, manifest])
  expect(next.note).toBe('Please review.\n\nBranch: handoff/chain @ abc')
  expect(next.request?.description).toBe('The final answer.\n\nBranch: handoff/chain @ abc')
  expect(original.files).toEqual(pins)
})

it.each([undefined, false])(
  'does not git-route ordinary repo files with includeWorkingTree=%s',
  async (includeWorkingTree) => {
    const original = rule({ includeWorkingTree })
    await expect(applySessionHandoffRouting(original, '/w', 'chain')).resolves.toBe(original)
    expect(prepareHandoffRoutes).not.toHaveBeenCalled()
  }
)

it.each([
  { chainId: undefined, connectionId: undefined },
  { chainId: 'chain', connectionId: 'remote-host' }
])('keeps bytes without a chain or on SSH: %j', async ({ chainId, connectionId }) => {
  const original = rule()
  await expect(applySessionHandoffRouting(original, '/w', chainId, connectionId)).resolves.toBe(
    original
  )
  expect(prepareHandoffRoutes).not.toHaveBeenCalled()
})

it('keeps non-repository pins as bytes, with their metadata and the manifest', async () => {
  vi.mocked(prepareHandoffRoutes).mockResolvedValue({
    ok: true,
    data: { git: null, pins: [], memoLines: [], refused: [], manifest: [] }
  })
  const original = rule({ files: [{ ...pins[0]!, taskPath: 'uploads/plan.md' }, pins[1]!] })
  const next = await applySessionHandoffRouting(original, '/w', 'chain')
  expect(next.files).toEqual(original.files)
  expect(next.note).toBe(original.note)
})

it('stops the entire send with the routing rule’s refusal reasons', async () => {
  vi.mocked(prepareHandoffRoutes).mockResolvedValue({
    ok: true,
    data: {
      git: null,
      pins,
      memoLines: [],
      manifest: [],
      refused: [
        { name: 'plan.md', reason: 'The source changed.' },
        { name: 'brief.pdf', reason: 'The file could not be read.' }
      ]
    }
  })
  await expect(applySessionHandoffRouting(rule(), '/w', 'chain')).rejects.toMatchObject({
    code: 'file-too-large',
    subject: 'plan.md, brief.pdf',
    detail: 'The source changed. The file could not be read.'
  })
})

it('propagates preparation failures before delivery', async () => {
  vi.mocked(prepareHandoffRoutes).mockResolvedValue({
    ok: false,
    error: { code: 'file_unavailable', message: 'Push failed.' }
  })
  await expect(applySessionHandoffRouting(rule(), '/w', 'chain')).rejects.toMatchObject({
    code: 'upload-failed',
    detail: 'Push failed.'
  })
})

it('can hand over a working tree without any declared files', async () => {
  vi.mocked(prepareHandoffRoutes).mockResolvedValue({
    ok: true,
    data: { git: null, pins: [manifest], memoLines: [], refused: [], manifest: [] }
  })
  const next = await applySessionHandoffRouting(rule({ files: [] }), '/w', 'chain')
  expect(prepareHandoffRoutes).toHaveBeenCalledWith(
    expect.objectContaining({ pins: [], includeWorkingTree: true })
  )
  expect(next.files).toEqual([manifest])
})
