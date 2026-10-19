import { describe, expect, it, vi, type Mock } from 'vitest'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import {
  resumeConversation,
  SessionResumeWorkspaceMissing,
  type SessionResumeDeps
} from './session-manage-resume'
import { SessionManagePartialError, SessionManageRefusal } from './session-manage-refusal'
import { manageEntry, sidebarRow } from './session-manage-test-fixtures'

const ID = '2f0c9f4e-8d1a-4c7e-9b8e-0e6f3f2a1b7c'
const REF = `claude:${ID}@local`
const MANAGED = '/Users/maintainer/app/claude-accounts/7b2e/auth/session'
const TRANSCRIPT = `${MANAGED}/projects/-w/${ID}.jsonl`
const actor = { kind: 'pane' as const, paneKey: 'tab-9:leaf-9', title: 'Planner' }

type ResumeDeps = SessionResumeDeps & {
  launch: Mock<SessionResumeDeps['launch']>
  restart: Mock<SessionResumeDeps['restart']>
}

function deps(overrides: Partial<SessionResumeDeps> = {}): ResumeDeps {
  const launch = vi.fn<SessionResumeDeps['launch']>(
    overrides.launch ??
      (async () => ({
        terminal: 'term_new',
        tabId: 'tab-7',
        paneKey: 'tab-7:leaf-7',
        disposition: 'created'
      }))
  )
  const restart = vi.fn<SessionResumeDeps['restart']>(
    overrides.restart ??
      (async () => ({
        dryRun: false,
        action: 'restart',
        target: { paneKey: 'tab-1:leaf-1', title: 'Parser fix' },
        actor,
        outcome: 'restarted',
        summary: 'Resumed “Parser fix”: the same conversation, in a new tab'
      }))
  )
  return {
    readRows: async () => [],
    observe: async () => manageEntry(),
    organization: async () => ({ deleted: false, hidden: false, archiveKind: null }),
    locate: async () => [{ path: TRANSCRIPT, providerRoot: MANAGED, defaultRoot: false }],
    transcriptCwd: async () => '/w',
    confirm: async () => ({ state: 'same', paneKey: 'tab-7:leaf-7' }),
    platform: 'darwin',
    hostLabel: 'laptop',
    ...overrides,
    launch,
    restart
  }
}

const held = (overrides: Partial<SessionManageSidebarRow> = {}) =>
  sidebarRow({ providerSessionId: ID, transcriptPath: TRANSCRIPT, ...overrides })

describe('omni session resume', () => {
  it('reopens a conversation whose tab was closed, in its folder and under its own profile', async () => {
    const resume = deps()
    const result = await resumeConversation(resume, { actor, ref: REF, dryRun: false })
    expect(resume.launch).toHaveBeenCalledWith({
      reference: { agent: 'claude', sessionId: ID, hostId: 'local' },
      transcriptPath: TRANSCRIPT,
      cwd: '/w',
      providerRoot: MANAGED
    })
    expect(result).toMatchObject({
      outcome: 'resumed',
      paneKey: 'tab-7:leaf-7',
      terminal: 'term_new',
      cwd: '/w',
      profile: { variable: 'CLAUDE_CONFIG_DIR', path: MANAGED, isDefault: false }
    })
    expect(result.summary).toContain('the same conversation, confirmed by its agent')
  })

  it('says an archived conversation reopens under Archived, since resuming never unarchives', async () => {
    const resume = deps({
      organization: async () => ({ deleted: false, hidden: false, archiveKind: 'automatic' })
    })
    const result = await resumeConversation(resume, { actor, ref: REF, dryRun: false })
    expect(result.summary).toContain(
      `It stays under Archived (filed automatically): omni session archive --ref ${REF} --unarchive brings it back.`
    )
  })

  it('unarchives an archived conversation it reopened when the caller asks', async () => {
    const unarchive = vi.fn(async () => {})
    const resume = deps({
      organization: async () => ({ deleted: false, hidden: false, archiveKind: 'manual' }),
      unarchive
    })
    const result = await resumeConversation(resume, { actor, ref: REF, dryRun: false })
    expect(unarchive).toHaveBeenCalledOnce()
    expect(result.summary).toContain('It was archived, so it was unarchived.')
  })

  it('resumes the default profile without a profile variable', async () => {
    const resume = deps({
      locate: async () => [
        {
          path: `/Users/maintainer/.claude/projects/-w/${ID}.jsonl`,
          providerRoot: '/Users/maintainer/.claude',
          defaultRoot: true
        }
      ]
    })
    await resumeConversation(resume, { actor, ref: REF, dryRun: false })
    expect(resume.launch).toHaveBeenCalledWith(expect.objectContaining({ providerRoot: null }))
  })

  it('reports a fresh conversation in its place as a failure, never a resume', async () => {
    const resume = deps({ confirm: async () => ({ state: 'different', reported: 'new-id' }) })
    const failure = resumeConversation(resume, { actor, ref: REF, dryRun: false })
    await expect(failure).rejects.toBeInstanceOf(SessionManagePartialError)
    await expect(failure).rejects.toThrow('opened a different conversation (new-id)')
    const unconfirmed = deps({ confirm: async () => ({ state: 'unconfirmed' }) })
    await expect(
      resumeConversation(unconfirmed, { actor, ref: REF, dryRun: false })
    ).rejects.toThrow('unconfirmed')
  })

  it('uses the terminal that already runs it instead of starting a second copy', async () => {
    const resume = deps({
      launch: vi.fn(async () => ({
        terminal: 'term_live',
        tabId: 'tab-3',
        paneKey: 'tab-3:leaf-3',
        disposition: 'adopted' as const
      }))
    })
    const result = await resumeConversation(resume, { actor, ref: REF, dryRun: false })
    expect(result.outcome).toBe('adopted')
    expect(result.paneKey).toBe('tab-3:leaf-3')
  })

  it('answers from a row that still holds it: open is nothing to do, exited resumes its checkpoint', async () => {
    const open = deps({ readRows: async () => [held()] })
    const openResult = await resumeConversation(open, { actor, ref: REF, dryRun: false })
    expect(openResult.outcome).toBe('already-open')
    expect(open.launch).not.toHaveBeenCalled()

    const exited = deps({
      readRows: async () => [held({ resumable: true })],
      observe: async () =>
        manageEntry({ verdict: 'exited', state: 'exited' } as Partial<SessionManageEntry>)
    })
    const exitedResult = await resumeConversation(exited, { actor, ref: REF, dryRun: false })
    expect(exitedResult.outcome).toBe('restarted')
    expect(exited.restart).toHaveBeenCalledTimes(1)
    expect(exited.launch).not.toHaveBeenCalled()
  })

  it('passes on a checkpoint restart its agent never confirmed, with the reason', async () => {
    const reason = 'its agent did not report which conversation it opened within 30 s'
    const exited = deps({
      readRows: async () => [held({ resumable: true })],
      observe: async () =>
        manageEntry({ verdict: 'exited', state: 'exited' } as Partial<SessionManageEntry>),
      restart: async () => ({
        dryRun: false,
        action: 'restart',
        target: { paneKey: 'tab-1:leaf-1', title: 'Parser fix' },
        actor,
        outcome: 'started_unconfirmed',
        reason,
        summary: `“Parser fix” was started again in a new tab, but ${reason}.`
      })
    })
    const result = await resumeConversation(exited, { actor, ref: REF, dryRun: false })
    expect(result).toMatchObject({ outcome: 'started_unconfirmed', reason })
    expect(result.summary).toContain(reason)
  })

  it('carries an exited row’s launch record onto the tab it reopens', async () => {
    const agentTemplate = { id: 'advertising', name: 'Advertising', digest: 'd30fc78b9495' }
    const exited = deps({
      readRows: async () => [held({ agentTemplate: null, resumeAgentTemplate: agentTemplate })],
      observe: async () =>
        manageEntry({ verdict: 'exited', state: 'exited' } as Partial<SessionManageEntry>)
    })
    await resumeConversation(exited, { actor, ref: REF, dryRun: false })
    expect(exited.launch).toHaveBeenCalledWith(expect.objectContaining({ agentTemplate }))
  })

  it('never opens a conversation a second time when its row cannot be verified', async () => {
    const resume = deps({
      readRows: async () => [held()],
      observe: async () => manageEntry({ verdict: 'unverifiable', state: 'unknown' })
    })
    await expect(resumeConversation(resume, { actor, ref: REF, dryRun: false })).rejects.toThrow(
      'never opened a second time'
    )
    expect(resume.launch).not.toHaveBeenCalled()
  })

  it.each([
    ['another host', { ref: `claude:${ID}@runtime:env-1` }, 'not supported yet'],
    [
      'two rows',
      { rows: [held(), held({ paneKey: 'tab-2:leaf-2', rowKey: 'r2' })] },
      'held by 2 sidebar rows'
    ],
    [
      'deleted by the person',
      { organization: { deleted: true, hidden: false, archiveKind: null } },
      'deleted this conversation'
    ],
    [
      'hidden by the person',
      { organization: { deleted: false, hidden: true, archiveKind: null } },
      'hid this conversation'
    ],
    ['an unreadable window', { organization: null }, 'could not say whether'],
    ['no transcript', { locate: [] }, 'source missing'],
    [
      'two transcripts',
      {
        locate: [
          { path: TRANSCRIPT, providerRoot: MANAGED, defaultRoot: false },
          {
            path: `/Users/maintainer/.claude/projects/-w/${ID}.jsonl`,
            providerRoot: '/Users/maintainer/.claude',
            defaultRoot: true
          }
        ]
      },
      'ambiguous'
    ],
    ['no recorded folder', { cwd: null }, 'does not record the folder']
  ])('refuses %s and changes nothing', async (_name, setup, words) => {
    const options = setup as {
      ref?: string
      rows?: SessionManageSidebarRow[]
      organization?: { deleted: boolean; hidden: boolean; archiveKind: null } | null
      locate?: { path: string; providerRoot: string; defaultRoot: boolean }[]
      cwd?: null
    }
    const resume = deps({
      ...(options.rows ? { readRows: async () => options.rows! } : {}),
      ...('organization' in options
        ? { organization: async () => options.organization ?? null }
        : {}),
      ...(options.locate ? { locate: async () => options.locate! } : {}),
      ...('cwd' in options ? { transcriptCwd: async () => null } : {})
    })
    const failure = resumeConversation(resume, { actor, ref: options.ref ?? REF, dryRun: false })
    await expect(failure).rejects.toBeInstanceOf(SessionManageRefusal)
    await expect(failure).rejects.toThrow(words)
    expect(resume.launch).not.toHaveBeenCalled()
    expect(resume.restart).not.toHaveBeenCalled()
  })

  it('names the by-hand command when its folder is not an open workspace', async () => {
    const resume = deps({
      launch: vi.fn(async () => {
        throw new SessionResumeWorkspaceMissing('selector_not_found')
      })
    })
    await expect(resumeConversation(resume, { actor, ref: REF, dryRun: false })).rejects.toThrow(
      `cd '/w' && CLAUDE_CONFIG_DIR='${MANAGED}' claude --resume '${ID}'`
    )
  })

  it('says what it would do on a dry run and launches nothing', async () => {
    const resume = deps()
    const result = await resumeConversation(resume, { actor, ref: REF, dryRun: true })
    expect(result.summary).toBe(
      `Would reopen ${REF} in a new tab in /w, under the profile ${MANAGED} (dry run: nothing changed).`
    )
    expect(result.outcome).toBeUndefined()
    expect(resume.launch).not.toHaveBeenCalled()
  })
})

describe('omni session resume for an answered decision', () => {
  const approval = {
    deliveryKey: 'review:plan:d42',
    approvedBy: 'sal@example.edu'
  }
  const deleted = { deleted: true, hidden: false, archiveKind: null, deletedKeys: ['k'] }
  const hidden = { deleted: false, hidden: true, archiveKind: null, hiddenKeys: ['k'] }

  it.each([
    ['deleted', deleted],
    ['hidden', hidden]
  ])('brings back a %s conversation, then resumes it', async (_name, organization) => {
    const restoreDeleted = vi.fn(async () => {})
    const resume = deps({ organization: async () => organization, restoreDeleted })
    const result = await resumeConversation(resume, {
      actor,
      ref: REF,
      dryRun: false,
      restoreDeleted: approval
    })
    expect(restoreDeleted).toHaveBeenCalledWith(
      { agent: 'claude', sessionId: ID, hostId: 'local' },
      organization,
      approval
    )
    expect(result.outcome).toBe('resumed')
    expect(resume.launch).toHaveBeenCalledTimes(1)
  })

  it('still refuses without the approval or without a restore path', async () => {
    const restoreDeleted = vi.fn(async () => {})
    const unasked = deps({ organization: async () => deleted, restoreDeleted })
    await expect(resumeConversation(unasked, { actor, ref: REF, dryRun: false })).rejects.toThrow(
      'Ask them first. Nothing changed.'
    )
    const noPath = deps({ organization: async () => deleted })
    await expect(
      resumeConversation(noPath, { actor, ref: REF, dryRun: false, restoreDeleted: approval })
    ).rejects.toThrow('Ask them first.')
    expect(restoreDeleted).not.toHaveBeenCalled()
    expect(unasked.launch).not.toHaveBeenCalled()
    expect(noPath.launch).not.toHaveBeenCalled()
  })

  it('keeps the row deleted when its transcript is gone or ambiguous', async () => {
    const restoreDeleted = vi.fn(async () => {})
    const resume = deps({
      organization: async () => deleted,
      restoreDeleted,
      locate: async () => []
    })
    await expect(
      resumeConversation(resume, { actor, ref: REF, dryRun: false, restoreDeleted: approval })
    ).rejects.toThrow('source missing')
    expect(restoreDeleted).not.toHaveBeenCalled()
  })

  it('refuses with the restore’s own words and launches nothing when the restore fails', async () => {
    const resume = deps({
      organization: async () => deleted,
      restoreDeleted: async () => {
        throw new Error('the window did not apply it. Nothing changed.')
      }
    })
    const failure = resumeConversation(resume, {
      actor,
      ref: REF,
      dryRun: false,
      restoreDeleted: approval
    })
    await expect(failure).rejects.toBeInstanceOf(SessionManageRefusal)
    await expect(failure).rejects.toThrow(
      'bringing it back for the answer failed: the window did not apply it. Nothing changed.'
    )
    expect(resume.launch).not.toHaveBeenCalled()
  })

  it('restores nothing on a dry run', async () => {
    const restoreDeleted = vi.fn(async () => {})
    const resume = deps({ organization: async () => deleted, restoreDeleted })
    const result = await resumeConversation(resume, {
      actor,
      ref: REF,
      dryRun: true,
      restoreDeleted: approval
    })
    expect(result.summary).toContain('dry run: nothing changed')
    expect(restoreDeleted).not.toHaveBeenCalled()
  })
})
