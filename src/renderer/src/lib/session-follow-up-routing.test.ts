import { beforeEach, describe, expect, it, vi } from 'vitest'

const prepareRoutes = vi.fn()
vi.mock('@/components/handoffs/handoff-client', () => ({
  handoffApi: () => ({ prepareRoutes })
}))

import type { SessionChain } from '../../../shared/session-chain-types'
import type { SessionFollowUpRule } from '../../../shared/session-follow-up-rule'
import type { followUpStepState } from './session-follow-up-step-state'
import { applyHandoffRouting } from './session-follow-up-routing'

const pins = [
  { sourcePath: '/w/docs/plan.md', name: 'plan.md', sha256: 'a'.repeat(64), size: 10 },
  { sourcePath: '/desk/brief.pdf', name: 'brief.pdf', sha256: 'b'.repeat(64), size: 20 }
]

function rule(patch: Partial<SessionFollowUpRule> = {}): SessionFollowUpRule {
  return {
    revision: 1,
    taskId: null,
    taskTitle: 'Seedance lander',
    sessionLabel: 'Seedance lander',
    recipients: [
      { employeeId: 'emp_uma', name: 'Uma', operationId: 'op_1', delivery: 'pending' }
    ],
    deliverables: { kind: 'files', paths: pins.map((pin) => pin.sourcePath!) },
    includeSummary: false,
    note: 'Take it from here.',
    savedAt: 1,
    files: pins,
    ...patch
  }
}

function state(chain: Partial<SessionChain> = {}) {
  const saved: SessionFollowUpRule[] = []
  return {
    view: () => ({
      chain: { id: 'chn_1', workspacePath: '/w', ...chain } as SessionChain,
      step: {} as never
    }),
    save: async (next: SessionFollowUpRule) => {
      saved.push(next)
    },
    saved
  } as never as ReturnType<typeof followUpStepState> & { saved: SessionFollowUpRule[] }
}

beforeEach(() => {
  prepareRoutes.mockReset()
})

describe('applying the routing rule before a handoff is sent', () => {
  it('asks for one branch per chain and drops the files the commit carries', async () => {
    prepareRoutes.mockResolvedValue({
      ok: true,
      data: {
        git: {
          repo: 'omnirogue/omni-ide',
          branch: 'handoff/chn_1',
          sha: 'abcdef1234567',
          baseBranch: 'main-next',
          remote: 'origin'
        },
        pins: [
          pins[1]!,
          {
            sourcePath: '/w/.omni/handoffs/handoff-chn_1/handoff-manifest.json',
            name: 'handoff-manifest.json',
            sha256: 'c'.repeat(64),
            size: 30
          }
        ],
        memoLines: ['Branch: handoff/chn_1 @ abcdef123456 (omnirogue/omni-ide)'],
        refused: [],
        manifest: []
      }
    })
    const store = state()

    const next = await applyHandoffRouting(store, rule())

    expect(prepareRoutes).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: '/w',
        branch: 'handoff/chn_1',
        label: 'Seedance lander',
        memo: 'Take it from here.',
        next: 'person',
        sameWorktree: false
      })
    )
    expect(next.files?.map((pin) => pin.name)).toEqual(['brief.pdf', 'handoff-manifest.json'])
    expect(next.note).toBe(
      'Take it from here.\n\nBranch: handoff/chn_1 @ abcdef123456 (omnirogue/omni-ide)'
    )
    expect(store.saved).toHaveLength(1)
  })

  it('stops the send when a file fits no route, naming it and saying why', async () => {
    prepareRoutes.mockResolvedValue({
      ok: true,
      data: {
        git: null,
        pins,
        memoLines: [],
        refused: [
          { name: 'render.mov', reason: 'render.mov is 41 MB; the card upload ceiling is 32 MB.' }
        ],
        manifest: []
      }
    })
    const store = state()

    await expect(applyHandoffRouting(store, rule())).rejects.toMatchObject({
      code: 'file-too-large',
      subject: 'render.mov',
      detail: 'render.mov is 41 MB; the card upload ceiling is 32 MB.'
    })
    expect(store.saved).toHaveLength(0)
  })

  it('stops the send when the preparation itself failed', async () => {
    prepareRoutes.mockResolvedValue({
      ok: false,
      error: { code: 'file_unavailable', message: 'The handoff branch could not be pushed.' }
    })

    await expect(applyHandoffRouting(state(), rule())).rejects.toMatchObject({
      code: 'upload-failed',
      detail: 'The handoff branch could not be pushed.'
    })
  })

  it('leaves a handoff with no files untouched', async () => {
    const empty = rule({ files: [] })
    await expect(applyHandoffRouting(state(), empty)).resolves.toBe(empty)
    expect(prepareRoutes).not.toHaveBeenCalled()
  })

  it.each<Partial<SessionFollowUpRule>>([
    { sourceConversationId: 'chat_original' },
    {
      transcriptSource: {
        kind: 'provider',
        hostId: 'ssh:source',
        agent: 'codex',
        sessionId: 'original'
      }
    },
    {
      sourceConversationId: 'chat_original',
      recipients: [],
      agentRecipients: [
        {
          kind: 'agent',
          id: 'session_uma',
          employeeId: 'emp_uma',
          projectId: 'project',
          name: 'Uma agent',
          operationId: 'op_agent',
          delivery: 'pending'
        }
      ]
    }
  ])(
    'keeps exact conversation attachment pins and the full note unchanged: %j',
    async (metadata) => {
      const exactRule = rule({
        ...metadata,
        note: 'An exact message with a Drive URL: https://drive.google.com/file/d/original/view',
        files: [
          ...pins,
          { sourcePath: '/w/assets', name: 'assets.tar.gz', sha256: 'c'.repeat(64), size: 400 }
        ]
      })
      const store = state({ hostId: 'ssh:source' })
      await expect(applyHandoffRouting(store, exactRule)).resolves.toBe(exactRule)
      expect(prepareRoutes).not.toHaveBeenCalled()
      expect(store.saved).toHaveLength(0)
    }
  )
})
