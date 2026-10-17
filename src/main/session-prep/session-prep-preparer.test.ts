import { describe, expect, it, vi } from 'vitest'
import type { GateFailure, PlannedItem, PreparedFields } from '../../shared/session-prep-types'
import { PREP_JSON_RETRY_LINE } from './session-prep-model-json'
import type { SessionPrepCallDeps } from './session-prep-planner'
import { prepare, revise } from './session-prep-preparer'

const item: PlannedItem = {
  title: 'Login fix',
  ask: 'Fix the login timeout',
  anchor: 'login timeout',
  direct: false,
  changesCode: true
}

const fields: PreparedFields = {
  title: 'Login fix',
  outcome: 'Existing users can sign in without the timeout.',
  doneWhen: ['Login test passes', 'The sign-in screen accepts a valid account'],
  decided: ['Keep the current auth provider'],
  references: [{ path: 'src/auth.ts', why: 'handles login' }],
  constraints: ['Do not change the password policy'],
  assumptions: ['Keep current copy'],
  blockingQuestion: null,
  changesCode: true
}

const input = {
  item,
  index: 0,
  siblings: [{ ...item, title: 'Docs pass', ask: 'Write docs', anchor: 'docs' }],
  request: 'Create sessions for the login timeout and the docs',
  context: 'User: the login times out',
  cwd: '/ws'
}

function depsFor(runText: SessionPrepCallDeps['runText']): SessionPrepCallDeps {
  return { runText, agent: 'claude', model: 'sonnet', effort: 'medium', timeoutMs: 360_000 }
}

describe('prepare', () => {
  it('parses a successful JSON reply', async () => {
    const runText = vi.fn(async () => JSON.stringify(fields))
    await expect(prepare(input, depsFor(runText))).resolves.toMatchObject({
      title: 'Login fix',
      outcome: fields.outcome,
      blockingQuestion: null
    })
    expect(runText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(input.request)
      })
    )
    expect(runText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(item.ask)
      })
    )
    expect(runText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Docs pass')
      })
    )
    expect(runText).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining('"decided":string[]') })
    )
    expect(runText).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining('not the launched session') })
    )
  })

  it('retries once then succeeds', async () => {
    const runText = vi.fn(async ({ prompt }: { prompt: string }) => {
      if (prompt.includes(PREP_JSON_RETRY_LINE)) {
        return JSON.stringify(fields)
      }
      return 'not json'
    })
    await expect(prepare(input, depsFor(runText))).resolves.toMatchObject({ title: 'Login fix' })
    expect(runText).toHaveBeenCalledTimes(2)
    expect(runText).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        prompt: expect.stringContaining(PREP_JSON_RETRY_LINE)
      })
    )
  })

  it('retries once then throws', async () => {
    const runText = vi.fn(async () => 'still not json')
    await expect(prepare(input, depsFor(runText))).rejects.toThrow(
      'preparation returned no usable result'
    )
    expect(runText).toHaveBeenCalledTimes(2)
  })
})

describe('revise', () => {
  it('includes failures and skips research unless a reference is missing', async () => {
    const runText = vi.fn(async () => JSON.stringify(fields))
    const failures: GateFailure[] = [{ code: 'placeholder', detail: 'unresolved placeholder TBD' }]
    await revise(
      { item, fields, failures, request: input.request, context: input.context, cwd: '/ws' },
      depsFor(runText)
    )
    expect(runText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('placeholder: unresolved placeholder TBD')
      })
    )
    expect(runText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Do not research again')
      })
    )
    expect(runText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.not.stringContaining('Research the workspace READ-ONLY again')
      })
    )
  })

  it('asks for research when a missing-reference failure is present', async () => {
    const runText = vi.fn(async () => JSON.stringify(fields))
    const failures: GateFailure[] = [
      { code: 'missing-reference', detail: '"src/missing.ts" does not exist' }
    ]
    await revise(
      { item, fields, failures, request: input.request, context: input.context, cwd: '/ws' },
      depsFor(runText)
    )
    expect(runText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('missing-reference: "src/missing.ts" does not exist')
      })
    )
    expect(runText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Research the workspace READ-ONLY again')
      })
    )
    expect(runText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.not.stringContaining('Do not research again')
      })
    )
  })

  it('keeps the earlier effort when the correction omits it', async () => {
    const runText = vi.fn(async () => JSON.stringify(fields))
    const revised = await revise(
      {
        item,
        fields: { ...fields, effort: 'high' },
        failures: [{ code: 'not-ready', detail: 'thin' }],
        request: input.request,
        context: input.context,
        cwd: '/ws'
      },
      depsFor(runText)
    )
    expect(revised.effort).toBe('high')
  })
})

describe('effort recommendation', () => {
  it('asks the preparer to size the effort and parses its answer', async () => {
    const runText = vi.fn(async () => JSON.stringify({ ...fields, effort: 'xhigh' }))
    const prepared = await prepare(input, depsFor(runText))
    expect(prepared.effort).toBe('xhigh')
    expect(runText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('"effort":"low"|"medium"|"high"|"xhigh"')
      })
    )
    expect(runText).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining('"low" for docs') })
    )
  })

  it('drops an unknown or person-only level without failing the preparation', async () => {
    for (const effort of ['max', 'extreme', 3]) {
      const runText = vi.fn(async () => JSON.stringify({ ...fields, effort }))
      const prepared = await prepare(input, depsFor(runText))
      expect(prepared.effort).toBeUndefined()
      expect(prepared.title).toBe('Login fix')
    }
  })
})
