import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import {
  resolveHubTaskResumeEnvironment,
  matchesCanonicalHubResumeSession
} from './hub-task-resume-environment'
import { canonicalizeAgentSessionIdentity } from '../agent-session-claim-identity'

describe('hub task resume environment', () => {
  let db: OrchestrationDb | undefined
  const roots: string[] = []

  afterEach(() => {
    db?.close()
    db = undefined
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores the durable card after reopening and overrides stale captured card variables', () => {
    const root = mkdtempSync(join(tmpdir(), 'omni-hub-resume-'))
    roots.push(root)
    const path = join(root, 'orchestration.db')
    db = new OrchestrationDb(path)
    db.createRun({
      objective: 'Keep the card',
      coordinatorHandle: 'term_worker',
      coordinatorPaneKey: 'tab_worker:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      hubTaskId: 'btk_durable'
    })
    db.close()
    db = new OrchestrationDb(path)

    expect(
      resolveHubTaskResumeEnvironment({
        db,
        candidates: [
          {
            paneKey: 'tab_worker:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            capturedEnv: {
              OMNI_TASK_ID: 'btk_stale',
              OMNIOS_URL: 'https://stale.invalid',
              PROFILE: 'saved'
            }
          }
        ]
      })
    ).toEqual({
      OMNI_TASK_ID: 'btk_durable',
      OMNIOS_URL: 'https://console.example.com',
      PROFILE: 'saved'
    })
  })

  it('preserves the saved card for an explicitly resumed settled session', () => {
    expect(
      resolveHubTaskResumeEnvironment({
        db: null,
        candidates: [
          {
            paneKey: 'settled-pane',
            capturedEnv: { OMNI_TASK_ID: 'btk_saved', PROFILE: 'saved' }
          }
        ]
      })
    ).toEqual({
      OMNI_TASK_ID: 'btk_saved',
      OMNIOS_URL: 'https://console.example.com',
      PROFILE: 'saved'
    })
  })

  it('does not change the environment for an unbound resume', () => {
    expect(
      resolveHubTaskResumeEnvironment({
        db: null,
        candidates: [
          {
            paneKey: 'unbound-pane',
            capturedEnv: { PROFILE: 'saved' }
          }
        ]
      })
    ).toBeUndefined()
  })

  it('pins a structured handoff to its durable session card and refuses a conflicting workspace', () => {
    expect(
      resolveHubTaskResumeEnvironment({
        db: null,
        candidates: [],
        sessionHubTaskId: 'btk_structured'
      })
    ).toEqual({ OMNI_TASK_ID: 'btk_structured', OMNIOS_URL: 'https://console.example.com' })
    expect(() =>
      resolveHubTaskResumeEnvironment({
        db: null,
        candidates: [],
        sessionHubTaskId: 'btk_structured',
        workspaceHubTaskId: 'btk_other'
      })
    ).toThrow('Conflicting omnios card identities')
  })

  it('refuses to replace a settled session card when its workspace is relinked', () => {
    expect(() =>
      resolveHubTaskResumeEnvironment({
        db: null,
        workspaceHubTaskId: 'btk_newworkspace',
        candidates: [
          {
            paneKey: 'settled',
            capturedEnv: { OMNI_TASK_ID: 'btk_originalsession' }
          }
        ]
      })
    ).toThrow('Conflicting omnios card identities')
  })

  it.skipIf(process.platform === 'win32')(
    'matches Pi and Prime transcript identity through canonical paths',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'omni-hub-transcript-'))
      roots.push(root)
      const path = join(root, 'session.jsonl')
      const alias = join(root, 'alias.jsonl')
      const other = join(root, 'other.jsonl')
      writeFileSync(path, '')
      writeFileSync(other, '')
      symlinkSync(path, alias)
      for (const agent of ['pi', 'prime-agent'] as const) {
        const canonical = canonicalizeAgentSessionIdentity(agent, {
          key: 'session_id',
          id: 'provider-id',
          transcriptPath: path
        }).providerSession
        expect(
          matchesCanonicalHubResumeSession(
            agent,
            { ...canonical, transcriptPath: alias },
            canonical
          )
        ).toBe(true)
        expect(
          matchesCanonicalHubResumeSession(
            agent,
            { ...canonical, transcriptPath: other },
            canonical
          )
        ).toBe(false)
      }
    }
  )

  it('refuses ambiguous and malformed saved card identities', () => {
    expect(() =>
      resolveHubTaskResumeEnvironment({
        db: null,
        candidates: [
          { paneKey: 'a', capturedEnv: { OMNI_TASK_ID: 'btk_first' } },
          { paneKey: 'b', capturedEnv: { OMNI_TASK_ID: 'btk_other' } }
        ]
      })
    ).toThrow('Conflicting omnios card identities')
    expect(() =>
      resolveHubTaskResumeEnvironment({
        db: null,
        candidates: [{ paneKey: 'a', capturedEnv: { OMNI_TASK_ID: 'btk_card\nextra instruction' } }]
      })
    ).toThrow('Invalid saved omnios card identity')
  })
})
