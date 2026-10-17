import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  SessionFolderEntry,
  SessionFolderOp,
  SessionFolderRelayRequest
} from '../../shared/session-folder-cli'
import { SESSION_ACTIONS_FILE, SessionActionsLog } from '../session-manage/session-actions-log'
import { OrganizationChangeLedger } from '../session-organization/organization-change-ledger'
import { OrganizationHistoryStore } from '../session-organization/organization-history-store'
import {
  createSessionPrepBatchFolder,
  ensureSessionPrepFolder,
  moveSessionPrepSession,
  recordedSessionPrepRequest
} from './session-prep-folders'
import { sessionPrepBatchFolderName } from './session-prep-batch-folder'

function entry(
  id: string,
  name: string,
  parentId: string | null,
  section: 'saved' | 'active',
  path: string
): SessionFolderEntry {
  return { id, name, parentId, section, path, color: null, sessionCount: 0 }
}

/** A tiny stand-in for the window's folder store: lists folders and applies create/move ops. */
function sidebar(initial: SessionFolderEntry[]) {
  const folders = [...initial]
  const ops: SessionFolderOp[] = []
  const recorded: SessionFolderRelayRequest[] = []
  let next = 1
  const request = async (req: SessionFolderRelayRequest): Promise<unknown> => {
    if (req.kind === 'list') {
      return { folders: [...folders] }
    }
    if (req.kind !== 'mutate') {
      recorded.push(req)
      return null
    }
    const op = req.op
    ops.push(op)
    if (op.kind === 'createFolder') {
      const parent = folders.find((folder) => folder.id === op.parent)
      const section = parent?.section ?? (op.saved ? 'saved' : 'active')
      const base = parent ? parent.path : section === 'saved' ? 'Saved Sessions' : ''
      const created = entry(
        `new-${next++}`,
        op.name,
        parent?.id ?? null,
        section,
        base ? `${base} / ${op.name}` : op.name
      )
      folders.push(created)
      return { summary: 'created', folder: created }
    }
    return { summary: 'moved', sessionKey: 'session-key-1' }
  }
  return { request, ops, folders, recorded }
}

const OMNIROGUE = entry('f-omni', 'OmniRogue', null, 'saved', 'Saved Sessions / OmniRogue')
const PROTOTYPES = entry(
  'f-proto',
  'Prototypes',
  'f-omni',
  'saved',
  'Saved Sessions / OmniRogue / Prototypes'
)

describe('ensureSessionPrepFolder', () => {
  it('finds an existing folder by the path the person said', async () => {
    const { request, ops } = sidebar([OMNIROGUE, PROTOTYPES])
    await expect(ensureSessionPrepFolder(request, 'OmniRogue / Prototypes')).resolves.toEqual({
      id: 'f-proto',
      path: 'Saved Sessions / OmniRogue / Prototypes'
    })
    expect(ops).toEqual([])
  })

  it('creates a missing folder under the saved parent that exists', async () => {
    const { request, ops } = sidebar([OMNIROGUE])
    await expect(ensureSessionPrepFolder(request, 'OmniRogue / Prototypes')).resolves.toEqual({
      id: 'new-1',
      path: 'Saved Sessions / OmniRogue / Prototypes'
    })
    expect(ops).toEqual([{ kind: 'createFolder', name: 'Prototypes', parent: 'f-omni' }])
  })

  it('creates the whole chain when nothing exists, in Saved Sessions when the path says so', async () => {
    const { request, ops } = sidebar([])
    await ensureSessionPrepFolder(request, 'Saved Sessions / Acme / Launch')
    expect(ops).toEqual([
      { kind: 'createFolder', name: 'Acme', saved: true },
      { kind: 'createFolder', name: 'Launch', parent: 'new-1' }
    ])
    const plain = sidebar([])
    await ensureSessionPrepFolder(plain.request, 'Acme')
    expect(plain.ops).toEqual([{ kind: 'createFolder', name: 'Acme' }])
  })

  it('refuses an ambiguous path instead of adding a look-alike', async () => {
    const { request, ops } = sidebar([
      entry('a', 'Prototypes', null, 'saved', 'Saved Sessions / Prototypes'),
      entry('b', 'Prototypes', null, 'active', 'Prototypes')
    ])
    await expect(ensureSessionPrepFolder(request, 'Prototypes')).rejects.toThrow(/matches 2/)
    expect(ops).toEqual([])
  })
})

describe('moveSessionPrepSession', () => {
  it('moves the new session row into the folder, waiting for it to be listed', async () => {
    const { request, ops } = sidebar([])
    await moveSessionPrepSession(
      request,
      { tabId: 'tab-1', paneKey: null },
      {
        id: 'f-proto',
        path: 'x'
      }
    )
    expect(ops).toEqual([
      {
        kind: 'moveSession',
        tabId: 'tab-1',
        destination: 'folder',
        folder: 'f-proto',
        waitMs: 5_000
      }
    ])
  })

  it('fails without a row to move', async () => {
    const { request } = sidebar([])
    await expect(moveSessionPrepSession(request, {}, { id: 'f', path: 'x' })).rejects.toThrow(
      /no sidebar row/
    )
  })
})

describe('createSessionPrepBatchFolder', () => {
  const origin = {
    batchId: 'batch-1',
    requestExcerpt: 'fix PDF export and the Refer copy',
    createdAt: 1,
    source: 'session-prep' as const
  }
  // 09:25 local time, whatever zone the test runs in.
  const at = new Date(2026, 8, 25, 9, 25).getTime()
  const name = (attempt: number) =>
    sessionPrepBatchFolderName('fix PDF export, Refer & Earn copy. Then deploy', at, attempt)

  it('creates a top-level Active folder and records its origin', async () => {
    const { request, ops, recorded } = sidebar([OMNIROGUE])
    const folder = await createSessionPrepBatchFolder(request, { name, origin })
    expect(folder).toEqual({ id: 'new-1', path: 'Launch · 09:25 · Fix PDF export Refer Earn copy' })
    expect(ops).toEqual([
      { kind: 'createFolder', name: 'Launch · 09:25 · Fix PDF export Refer Earn copy' }
    ])
    expect(recorded).toEqual([
      { kind: 'recordBatchFolder', origin: { ...origin, folderId: 'new-1' } }
    ])
  })

  it('never files into a same-named folder: a minute-level repeat gets a suffix', async () => {
    const taken = entry('old', name(1), null, 'active', name(1))
    const { request, ops } = sidebar([taken])
    const folder = await createSessionPrepBatchFolder(request, { name, origin })
    expect(folder.path).toBe('Launch · 09:25 · Fix PDF export Refer Earn copy · 2')
    expect(ops).toEqual([{ kind: 'createFolder', name: folder.path }])
  })

  it('still returns the folder when its origin cannot be recorded', async () => {
    const base = sidebar([])
    const request = async (req: SessionFolderRelayRequest) => {
      if (req.kind === 'recordBatchFolder') {
        throw new Error('no window')
      }
      return base.request(req)
    }
    await expect(createSessionPrepBatchFolder(request, { name, origin })).resolves.toMatchObject({
      id: 'new-1'
    })
  })
})

describe('sessionPrepBatchFolderName', () => {
  const at = new Date(2026, 8, 25, 21, 5).getTime()

  it('caps the whole name at 60 characters, suffix included, on a word boundary', () => {
    const long = 'rebuild the entire checkout pipeline with the new payment provider and every test'
    for (const attempt of [1, 2, 9]) {
      const named = sessionPrepBatchFolderName(long, at, attempt)
      expect(named.length).toBeLessThanOrEqual(60)
      expect(named.startsWith('Launch · 21:05 · Rebuild the entire')).toBe(true)
    }
    expect(sessionPrepBatchFolderName(long, at, 3).endsWith(' · 3')).toBe(true)
  })

  it('is just the time when the request has no words to name it by', () => {
    expect(sessionPrepBatchFolderName('!!! ???', at)).toBe('Launch · 21:05')
  })
})

describe('recordedSessionPrepRequest', () => {
  it('records filing, folder creation included, as launch filing with the request’s words', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-prep-filing-'))
    try {
      const store = new OrganizationHistoryStore({ directory: join(dir, 'history') })
      const ledger = new OrganizationChangeLedger({ trail: new SessionActionsLog(dir), store })
      const { request, ops } = sidebar([OMNIROGUE])
      const filing = recordedSessionPrepRequest(request, ledger, 'build the checkout prototype')
      const folder = await ensureSessionPrepFolder(filing, 'OmniRogue / Prototypes')
      await moveSessionPrepSession(filing, { tabId: 'tab-1', paneKey: null }, folder)
      expect(ops.map((op) => op.kind)).toEqual(['createFolder', 'moveSession'])
      const lines = readFileSync(join(dir, SESSION_ACTIONS_FILE), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      const reason = 'filed at launch from request "build the checkout prototype"'
      expect(lines.map((line) => [line.action, line.phase, line.reason, line.executor])).toEqual([
        ['folder.create', 'prepared', reason, { kind: 'launch', source: 'session-prep' }],
        ['folder.create', 'applied', reason, { kind: 'launch', source: 'session-prep' }],
        ['session.move', 'prepared', reason, { kind: 'launch', source: 'session-prep' }],
        ['session.move', 'applied', reason, { kind: 'launch', source: 'session-prep' }]
      ])
      expect(lines[3]).toMatchObject({ request: 'build the checkout prototype' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('records a batch folder as launch filing, and passes its origin record through', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-prep-batch-filing-'))
    try {
      const store = new OrganizationHistoryStore({ directory: join(dir, 'history') })
      const ledger = new OrganizationChangeLedger({ trail: new SessionActionsLog(dir), store })
      const { request, recorded } = sidebar([])
      const origin = {
        batchId: 'batch-1',
        requestExcerpt: 'fix PDF export',
        createdAt: 1,
        source: 'session-prep' as const
      }
      const filing = recordedSessionPrepRequest(request, ledger, 'fix PDF export')
      await createSessionPrepBatchFolder(filing, {
        name: () => 'Launch · 09:25 · Fix PDF export',
        origin
      })
      expect(recorded).toEqual([
        { kind: 'recordBatchFolder', origin: { ...origin, folderId: 'new-1' } }
      ])
      const lines = readFileSync(join(dir, SESSION_ACTIONS_FILE), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      const reason = 'filed at launch from request "fix PDF export"'
      expect(lines.map((line) => [line.action, line.phase, line.reason])).toEqual([
        ['folder.create', 'prepared', reason],
        ['folder.create', 'applied', reason]
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
