import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../args'
import { printHelp } from '../help'
import type { RuntimeClient } from '../runtime-client'
import { COMMAND_SPECS } from '../specs'
import { RuntimeClientError } from '../runtime-client'
import { fileNewTerminal, SESSION_FOLDER_HANDLERS } from './session-folders'

const LEAF = '11111111-1111-4111-8111-111111111111'

/** What `sessionManage.list` answers: a finished Council conversation in tab-w, with no pane. */
const LISTED = {
  sessions: [
    {
      paneKey: null,
      tabId: 'tab-w',
      workflow: { controller: 'local', preset: 'council', runId: 'execution-1', status: 'done' }
    },
    { paneKey: null, tabId: 'tab-7' }
  ]
}

function client(showResult?: unknown) {
  const call = vi.fn(async (method: string) =>
    method === 'terminal.show'
      ? { result: showResult }
      : method === 'sessionManage.list'
        ? { result: LISTED }
        : { result: { summary: 'done', sessionKey: 'k' } }
  )
  return { call, client: { call, isRemote: false } as unknown as RuntimeClient }
}

async function run(argv: string[], showResult?: unknown) {
  const parsed = parseArgs(argv)
  const handler = SESSION_FOLDER_HANDLERS[parsed.commandPath.join(' ')]!
  const fake = client(showResult)
  await handler({ flags: parsed.flags, client: fake.client, cwd: '/tmp', json: true })
  return fake.call
}

function mutateOp(call: ReturnType<typeof vi.fn>): unknown {
  const mutate = call.mock.calls.find(([method]) => method === 'sessionFolders.mutate')
  return (mutate?.[1] as { op: unknown } | undefined)?.op
}

describe('omni folder delete / move --before|--after', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sends one deleteFolder op, with or without --keep-sessions', async () => {
    const plain = await run(['folder', 'delete', '--folder', 'Clients / Acme'])
    expect(mutateOp(plain)).toEqual({ kind: 'deleteFolder', folder: 'Clients / Acme' })
    const kept = await run(['folder', 'delete', '--keep-sessions', '--folder', 'Old'])
    expect(mutateOp(kept)).toEqual({ kind: 'deleteFolder', folder: 'Old' })
  })

  it('reorders beside a sibling', async () => {
    const before = await run(['folder', 'move', '--folder', 'Sales', '--before', 'Marketing'])
    expect(mutateOp(before)).toEqual({
      kind: 'reorderFolder',
      folder: 'Sales',
      target: 'Marketing',
      position: 'before'
    })
    const after = await run(['folder', 'move', '--folder', 'Sales', '--after', 'Marketing'])
    expect(mutateOp(after)).toMatchObject({ kind: 'reorderFolder', position: 'after' })
  })

  it('refuses two destinations, and --saved with --before', async () => {
    await expect(
      run(['folder', 'move', '--folder', 'A', '--before', 'B', '--into', 'C'])
    ).rejects.toThrow('exactly one of')
    await expect(
      run(['folder', 'move', '--folder', 'A', '--after', 'B', '--saved'])
    ).rejects.toThrow('--saved/--active go with --top')
  })

  it('documents the delete semantics in --help', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    printHelp(COMMAND_SPECS, ['folder', 'delete'])
    const help = log.mock.calls.flat().join('\n')
    expect(help).toContain('Its subfolders move up to its parent folder')
    expect(help).toContain('--keep-sessions spells that out and changes nothing')
  })
})

describe('omni session archive / delete', () => {
  const originalPane = process.env.ORCA_PANE_KEY
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    process.env.ORCA_PANE_KEY = 'tab-own:pane'
  })
  afterEach(() => {
    vi.restoreAllMocks()
    if (originalPane === undefined) {
      delete process.env.ORCA_PANE_KEY
    } else {
      process.env.ORCA_PANE_KEY = originalPane
    }
  })

  it('archives the pane it runs in by default, and unarchives on request', async () => {
    expect(mutateOp(await run(['session', 'archive']))).toEqual({
      kind: 'archiveSession',
      paneKey: 'tab-own:pane',
      archived: true
    })
    expect(mutateOp(await run(['session', 'archive', '--unarchive']))).toMatchObject({
      archived: false
    })
  })

  it('resolves --terminal to its tab and pane before deleting', async () => {
    const call = await run(['session', 'delete', '--terminal', 'term-1', '--force'], {
      terminal: { tabId: 'tab-9', leafId: LEAF }
    })
    expect(call).toHaveBeenCalledWith('terminal.show', { terminal: 'term-1' })
    expect(mutateOp(call)).toEqual({
      kind: 'deleteSession',
      paneKey: `tab-9:${LEAF}`,
      tabId: 'tab-9',
      force: true
    })
  })

  it('falls back to the tab when the leaf id is not a pane id, and refuses --terminal with --pane', async () => {
    const call = await run(['session', 'move', '--terminal', 'term-1', '--unfile'], {
      terminal: { tabId: 'tab-9', leafId: '3' }
    })
    expect(mutateOp(call)).toEqual({ kind: 'moveSession', tabId: 'tab-9', destination: 'unfile' })
    await expect(run(['session', 'delete', '--terminal', 'term-1', '--pane', 'p'])).rejects.toThrow(
      'not both'
    )
  })

  it('asks for a target outside a pane', async () => {
    delete process.env.ORCA_PANE_KEY
    await expect(run(['session', 'delete'])).rejects.toThrow('--terminal <handle>')
  })
  it("deletes a row with no pane by its tab, only with --unverified and the person's words", async () => {
    const call = await run([
      'session',
      'delete',
      '--tab-id',
      'tab-7',
      '--unverified',
      '--request',
      'delete all sessions'
    ])
    expect(mutateOp(call)).toEqual({ kind: 'deleteSession', tabId: 'tab-7', unverified: true })
    await expect(run(['session', 'delete', '--pane', 'p', '--unverified'])).rejects.toThrow(
      '--request'
    )
    await expect(run(['session', 'delete', '--tab-id', 'tab-7', '--pane', 'p'])).rejects.toThrow(
      'Pass --tab-id alone'
    )
  })

  // Why (C6): a workflow conversation has no pane; the window finds it by its controller and run.
  it('archives and deletes a workflow conversation by its tab, sending its run', async () => {
    const workflow = { controller: 'local', runId: 'execution-1' }
    const archived = await run(['session', 'archive', '--tab-id', 'tab-w'])
    expect(mutateOp(archived)).toEqual({
      kind: 'archiveSession',
      tabId: 'tab-w',
      workflow,
      archived: true
    })
    const deleted = await run(['session', 'delete', '--tab-id', 'tab-w'])
    expect(mutateOp(deleted)).toEqual({ kind: 'deleteSession', tabId: 'tab-w', workflow })
    await expect(run(['session', 'archive', '--tab-id', 'tab-7'])).rejects.toThrow(
      'No workflow conversation lives in tab tab-7'
    )
  })
})

describe('filing a just-launched terminal', () => {
  const terminal = { handle: 'term-1', tabId: 'tab-1', paneKey: 'tab-1:leaf-1' } as never

  it('marks the move as launch filing, so it records launch’s reason instead of needing one', async () => {
    const call = vi.fn(async () => ({ result: { summary: 'Moved' } }))
    const runtime = { call, isRemote: false } as unknown as RuntimeClient
    await fileNewTerminal(runtime, terminal, 'folder-1', 'session-launch')
    expect(call).toHaveBeenCalledWith('sessionFolders.mutate', {
      op: {
        kind: 'moveSession',
        paneKey: 'tab-1:leaf-1',
        tabId: 'tab-1',
        destination: 'folder',
        folder: 'folder-1',
        waitMs: 5_000
      },
      launch: 'session-launch'
    })
  })

  it('files without the marker when an older runtime refuses it', async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(
        new RuntimeClientError('invalid_argument', 'Unrecognized key: "launch"')
      )
      .mockResolvedValueOnce({ result: { summary: 'Moved' } })
    const runtime = { call, isRemote: false } as unknown as RuntimeClient
    await expect(fileNewTerminal(runtime, terminal, 'folder-1')).resolves.toEqual({
      summary: 'Moved'
    })
    expect(call.mock.calls.map(([, params]) => (params as { launch?: string }).launch)).toEqual([
      'terminal-create',
      undefined
    ])
  })

  it('does not retry a refusal that is about something else', async () => {
    const call = vi
      .fn()
      .mockRejectedValue(new RuntimeClientError('invalid_argument', 'No folder matches "x"'))
    const runtime = { call, isRemote: false } as unknown as RuntimeClient
    await expect(fileNewTerminal(runtime, terminal, 'x')).rejects.toThrow('could not file it')
    expect(call).toHaveBeenCalledTimes(1)
  })
})
