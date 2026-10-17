import { describe, expect, it, vi } from 'vitest'
import type { ExactHandoffFile } from './console-handoff-contract'
import {
  captureFollowUpFiles,
  deliverSessionFollowUp,
  resolveFollowUpFiles,
  type FollowUpDeliveryContext
} from './session-follow-up-delivery'
import { packageFileNames } from './session-follow-up-package-names'
import type { SessionFollowUpRule } from './session-follow-up-rule'

const RUN = '/w/.omni/runs/source_722a4028ecabb39e157faca322b77eacbbdc497a'
const FIRST = `${RUN}/codex-review_476f86d0-0ac5-4c6a-ad7a-5e8cf266b7ba`
const SECOND = `${RUN}/codex-review_c97ef95e-bde6-43b5-b1d3-07af4955442f`
const entry = (sourcePath: string | null, name = sourcePath!.split('/').at(-1)!) => ({
  sourcePath,
  name
})

function exactFile(name: string, text: string): ExactHandoffFile {
  return { name, contentBase64: btoa(text), sha256: text.padEnd(64, '0').slice(0, 64), size: 1 }
}

describe('handoff package names', () => {
  it('names two runs’ same-named outputs after their steps (chain source_5c1e3ce1, 2026-09-18)', () => {
    expect(
      packageFileNames([
        entry(`${FIRST}/manifest.md`),
        entry(`${FIRST}/evidence/F1.txt`),
        entry(`${SECOND}/manifest.md`),
        entry(null, 'session-operation.md')
      ])
    ).toEqual({
      names: [
        'codex-review_476f86d0-manifest.md',
        'F1.txt',
        'codex-review_c97ef95e-manifest.md',
        'session-operation.md'
      ]
    })
  })

  it('is the same whatever order the files are listed in', () => {
    const listed = [entry(`${FIRST}/manifest.md`), entry(`${SECOND}/manifest.md`)]
    const forward = packageFileNames(listed)
    const backward = packageFileNames(listed.toReversed())
    expect('names' in backward && backward.names.toReversed()).toEqual(
      'names' in forward && forward.names
    )
  })

  it('never renames the person’s own file; the run’s output gives way', () => {
    expect(packageFileNames([entry('/w/docs/manifest.md'), entry(`${FIRST}/manifest.md`)])).toEqual(
      { names: ['manifest.md', 'codex-review_476f86d0-manifest.md'] }
    )
  })

  it('adds the folders inside a run, then the run, until the names differ', () => {
    expect(
      packageFileNames([entry(`${FIRST}/notes.md`), entry(`${FIRST}/evidence/notes.md`)])
    ).toEqual({
      names: ['codex-review_476f86d0-notes.md', 'codex-review_476f86d0-evidence-notes.md']
    })
    expect(
      packageFileNames([
        entry('/w/.omni/runs/source_aaaaaaaa1111/plan.md'),
        entry('/w/.omni/runs/source_bbbbbbbb2222/plan.md')
      ])
    ).toEqual({ names: ['source_aaaaaaaa-plan.md', 'source_bbbbbbbb-plan.md'] })
  })

  it('treats names differing only by case as the same name', () => {
    expect(
      packageFileNames([entry(`${FIRST}/Manifest.md`), entry(`${SECOND}/manifest.md`)])
    ).toEqual({ names: ['codex-review_476f86d0-Manifest.md', 'codex-review_c97ef95e-manifest.md'] })
  })

  it('still refuses what renaming a run’s output cannot settle', () => {
    expect(packageFileNames([entry('/w/report.md'), entry('/w/other/report.md')])).toEqual({
      duplicate: 'report.md'
    })
    expect(packageFileNames([entry('/w/summary.md'), entry(null, 'summary.md')])).toEqual({
      duplicate: 'summary.md'
    })
  })
})

describe('a package with two runs’ manifests', () => {
  const sources: Record<string, ExactHandoffFile> = {
    [`${FIRST}/manifest.md`]: exactFile('manifest.md', 'a'),
    [`${SECOND}/manifest.md`]: exactFile('manifest.md', 'b'),
    '/w/report.md': exactFile('report.md', 'c')
  }
  const io = {
    exists: async () => true,
    size: async () => 1,
    readExact: async (path: string) => sources[path]!
  }

  it('is captured under distinct names and delivered under them after a restart', async () => {
    const capture = await captureFollowUpFiles(Object.keys(sources), null, io)
    expect(capture.pins.map((pin) => pin.name)).toEqual([
      'codex-review_476f86d0-manifest.md',
      'codex-review_c97ef95e-manifest.md',
      'report.md'
    ])
    expect(capture.bytes.get('codex-review_c97ef95e-manifest.md')).toMatchObject({
      name: 'codex-review_c97ef95e-manifest.md',
      sha256: sources[`${SECOND}/manifest.md`]!.sha256
    })

    let rule: SessionFollowUpRule = {
      revision: 1,
      taskId: null,
      taskTitle: 'Result',
      sessionLabel: 'Source',
      disposition: 'ownership-transfer',
      recipients: [
        {
          employeeId: 'emp_sal_qa_test',
          name: 'Sal Test Blake Test',
          operationId: 'operation_1234',
          delivery: 'pending'
        }
      ],
      action: 'edit',
      deliverables: { kind: 'files', paths: Object.keys(sources) },
      includeSummary: false,
      note: 'Take this over.',
      savedAt: 1,
      capturedAt: 2,
      files: capture.pins
    }
    const sendCardless = vi.fn(async () => ({ thread_id: 'hth_thread1234' }))
    const ctx: FollowUpDeliveryContext = {
      current: () => rule,
      save: async (value) => {
        rule = value
      },
      hub: {
        upload: vi.fn(),
        send: vi.fn(),
        sendCardless,
        uploadThreadFile: vi.fn(),
        isRejected: () => true
      },
      // Why: after a restart the bytes are re-read from the source, under the source's own name.
      bytes: async (pin) => sources[pin.sourcePath!]!,
      now: () => 3,
      sleep: vi.fn()
    }
    expect(await deliverSessionFollowUp(ctx)).toBe('delivered')
    const [[sent]] = sendCardless.mock.calls as unknown as [[{ attachments: ExactHandoffFile[] }]]
    expect(sent.attachments.map((file) => file.name)).toEqual(capture.pins.map((pin) => pin.name))
  })
})

describe('a stage that improved the person’s own files', () => {
  const step = '/w/.omni/runs/source_57d8202c/2f5f0670_work_seat_1'
  const manifest = exactFile(
    'manifest.md',
    '- `handoff-live/improved-5.md` - created\n- `notes.md` - beside the manifest\n'
  )
  const present = new Set([
    `${step}/manifest.md`,
    '/w/handoff-live/improved-5.md',
    `${step}/notes.md`,
    '/w/notes.md'
  ])
  const io = {
    exists: async (path: string) => present.has(path),
    size: async () => 1,
    readExact: async () => manifest
  }
  const rule = (manifestPath: string) =>
    ({ deliverables: { kind: 'manifest', manifestPath } }) as unknown as SessionFollowUpRule

  it('finds a manifest entry named from the workspace root (chain source_57d8202c, 2026-09-18)', async () => {
    expect(await resolveFollowUpFiles(rule(`${step}/manifest.md`), '/w', io)).toEqual({
      // Why: beside the manifest wins when the file is there, even if the workspace has one too.
      paths: ['/w/handoff-live/improved-5.md', `${step}/notes.md`],
      missing: []
    })
  })

  it('still reports a file that is in neither place, by name', async () => {
    present.delete('/w/handoff-live/improved-5.md')
    expect(await resolveFollowUpFiles(rule(`${step}/manifest.md`), '/w', io)).toEqual({
      paths: [`${step}/handoff-live/improved-5.md`, `${step}/notes.md`],
      missing: ['improved-5.md']
    })
  })
})
