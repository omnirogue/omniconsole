import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  customerServiceLaunchId,
  customerServiceLaunchSchema,
  type CustomerServiceLaunch,
  type CustomerServicePreview
} from '../../shared/customer-service-launch'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import { captureConsoleWorkflowPerson } from '../backoffice/console-workflow-person'
import { failure, requestConsoleWorkflow } from '../backoffice/console-workflow-transport'
import type { CustomerServiceLaunchStore } from './launch-store'
import type { LedgerLocalSession } from '../../shared/session-ledger-contract'

type PersonResult = Awaited<ReturnType<typeof captureConsoleWorkflowPerson>>
type Person = Extract<PersonResult, { ok: true }>['data']
type Preview = { person: Person; launch: CustomerServiceLaunch; key: string }
type Dependencies = {
  store: CustomerServiceLaunchStore
  localSessions(): LedgerLocalSession[]
  capture?: typeof captureConsoleWorkflowPerson
  request?: typeof requestConsoleWorkflow
}
const beginSchema = z.object({ previewKey: z.string().uuid() }).strict()
const receiptSchema = beginSchema.extend({ tabId: z.string().min(1).max(200).optional() })

export class CustomerServiceLaunchService {
  private readonly previews = new Map<string, Preview>()
  private readonly busy = new Set<string>()
  constructor(private readonly deps: Dependencies) {}

  async preview(value: unknown): Promise<ConsoleWorkflowResult<CustomerServicePreview>> {
    const id = customerServiceLaunchId.safeParse(value)
    if (!id.success) {
      return failure('invalid_request', 'Invalid Customer Service launch link.')
    }
    const person = await (this.deps.capture ?? captureConsoleWorkflowPerson)()
    if (!person.ok) {
      return person
    }
    const response = await this.send(person.data, id.data, 'GET')
    if (!response.ok) {
      return response
    }
    if (response.data.launch_id !== id.data) {
      return failure('invalid_response', 'Launch identity did not match.')
    }
    const key = createHash('sha256')
      .update(JSON.stringify([person.data.profileKey, person.data.principal, id.data]))
      .digest('hex')
    try {
      const local = this.deps.store.read(key)
      const previewKey = randomUUID()
      this.previews.set(previewKey, { person: person.data, launch: response.data, key })
      if (this.previews.size > 100) {
        this.previews.delete(this.previews.keys().next().value!)
      }
      const localState =
        response.data.status === 'launched'
          ? 'launched'
          : local?.tabId
            ? 'receipt-pending'
            : local?.phase === 'launching' ||
                local?.phase === 'launched' ||
                (response.data.claim_id && response.data.claim_id !== local?.claimId)
              ? 'unverifiable'
              : 'ready'
      return { ok: true, data: { launch: response.data, previewKey, localState } }
    } catch {
      return failure(
        'launch_journal_unavailable',
        'The local launch record could not be read. No new session was started.'
      )
    }
  }

  async begin(value: unknown): Promise<ConsoleWorkflowResult<CustomerServiceLaunch>> {
    const args = beginSchema.safeParse(value)
    if (!args.success) {
      return failure('invalid_request', 'Invalid launch confirmation.')
    }
    const preview = this.current(args.data.previewKey)
    if (!preview) {
      return failure('connection_changed', 'Refresh the launch preview after signing in.')
    }
    if (this.busy.has(preview.key)) {
      return failure('launch_busy', 'This launch is already being processed.')
    }
    this.busy.add(preview.key)
    try {
      let local = this.deps.store.read(preview.key)
      if (local && local.phase !== 'claiming') {
        return failure(
          'launch_unverifiable',
          'This launch was already attempted. Check its session before starting new work.'
        )
      }
      if (!local) {
        local = { launchId: preview.launch.launch_id, claimId: randomUUID(), phase: 'claiming' }
        this.deps.store.write(preview.key, local)
      }
      const claimed = await this.send(preview.person, local.launchId, 'POST', 'claim', {
        claim_id: local.claimId
      })
      if (!claimed.ok) {
        return claimed
      }
      if (
        claimed.data.launch_id !== local.launchId ||
        claimed.data.claim_id !== local.claimId ||
        claimed.data.status !== 'claimed' ||
        claimed.data.session_ledger_id ||
        claimed.data.brief !== preview.launch.brief ||
        JSON.stringify(claimed.data.company) !== JSON.stringify(preview.launch.company) ||
        JSON.stringify(claimed.data.ticket_ids) !== JSON.stringify(preview.launch.ticket_ids)
      ) {
        return failure(
          'launch_unverifiable',
          'This launch already belongs to an existing session or another computer.'
        )
      }
      if (!preview.person.isCurrent()) {
        return failure(
          'connection_changed',
          'The signed-in person changed. Refresh before continuing.'
        )
      }
      // Persist before granting the single launch permit; a lost reply is an unknown outcome.
      this.deps.store.write(preview.key, { ...local, phase: 'launching' })
      return claimed
    } catch {
      return failure(
        'launch_journal_unavailable',
        'The launch could not be recorded safely. Check its current result before trying again.'
      )
    } finally {
      this.busy.delete(preview.key)
    }
  }

  async receipt(value: unknown): Promise<ConsoleWorkflowResult<CustomerServiceLaunch>> {
    const args = receiptSchema.safeParse(value)
    if (!args.success) {
      return failure('invalid_request', 'Invalid launch receipt.')
    }
    const preview = this.current(args.data.previewKey)
    if (!preview) {
      return failure('connection_changed', 'Refresh the launch preview after signing in.')
    }
    if (this.busy.has(preview.key)) {
      return failure('launch_busy', 'This launch is already being processed.')
    }
    this.busy.add(preview.key)
    try {
      let local = this.deps.store.read(preview.key)
      if (!local || local.phase === 'claiming') {
        return failure('invalid_request', 'No local launch attempt was recorded.')
      }
      if (args.data.tabId && local.tabId && args.data.tabId !== local.tabId) {
        return failure('invalid_request', 'The session does not match the original launch.')
      }
      if (!local.tabId && args.data.tabId) {
        local = { ...local, tabId: args.data.tabId }
        this.deps.store.write(preview.key, local)
      }
      const tabId = local.tabId
      const matches = tabId
        ? this.deps.localSessions().filter((row) => row.paneId.startsWith(`${tabId}:`))
        : []
      const ledgerId = local.ledgerId ?? (matches.length === 1 ? matches[0].ledgerId : undefined)
      if (!ledgerId) {
        return failure(
          'receipt_pending',
          'The session opened; its ledger receipt is still pending. Retry recording the receipt.'
        )
      }
      local = { ...local, ledgerId }
      this.deps.store.write(preview.key, local)
      const response = await this.send(preview.person, local.launchId, 'POST', 'receipt', {
        claim_id: local.claimId,
        session_ledger_id: ledgerId
      })
      if (!response.ok) {
        return response
      }
      if (
        response.data.launch_id !== local.launchId ||
        response.data.claim_id !== local.claimId ||
        response.data.session_ledger_id !== ledgerId ||
        response.data.status !== 'launched'
      ) {
        return failure('invalid_response', 'The session receipt did not match this launch.')
      }
      this.deps.store.write(preview.key, { ...local, phase: 'launched' })
      return response
    } catch {
      return failure(
        'receipt_pending',
        'The launch receipt could not be recorded. The session must not be started again.'
      )
    } finally {
      this.busy.delete(preview.key)
    }
  }

  private current(key: string): Preview | null {
    const preview = this.previews.get(key)
    return preview?.person.isCurrent() ? preview : null
  }

  private send(
    person: Person,
    id: string,
    method: 'GET' | 'POST',
    action?: 'claim' | 'receipt',
    body?: unknown
  ): Promise<ConsoleWorkflowResult<CustomerServiceLaunch>> {
    return (this.deps.request ?? requestConsoleWorkflow)(
      `/api/customer-service/session-launches/${id}${action ? `/${action}` : ''}`,
      method,
      customerServiceLaunchSchema,
      body,
      15_000,
      true,
      person.principal,
      person.isCurrent
    )
  }
}
