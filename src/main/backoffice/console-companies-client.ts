import { z } from 'zod'
import { workFolders } from '../../shared/console-work-folders-contract'
import {
  accountingSnapshot,
  accountingSyncReceipt,
  accountingTransactionsCsv,
  accountingCompany,
  type AccountingCompany
} from '../../shared/console-accounting-contract'
import {
  companyId,
  consoleMe,
  estateCompany,
  estateMissions,
  estateRollup,
  estateToday,
  healthScope,
  orgChart,
  orgView,
  type ConsoleCompaniesApi
} from '../../shared/console-companies-contract'
import { scorecardDocument } from '../../shared/console-scorecard-contract'
import { companyHealthView } from '../../shared/console-company-health-contract'
import { readFetchResponseTextWithinLimit } from '../../shared/fetch-response-body'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { failure, requestConsoleWorkflow as request, validated } from './console-workflow-transport'

const companyRequest = z.object({ companyId }).strict()
const accountingRequest = z.object({ company: accountingCompany }).strict()
/** A bank export is text, not a workflow document: cap it well below a runaway feed. */
const CSV_MAX_BYTES = 8 * 1024 * 1024

function healthPath({ company, domain }: { company?: string; domain?: string }): string {
  const query = new URLSearchParams()
  if (company) {
    query.set('company', company)
  }
  // The BFF scopes a domain only within a company; a bare domain is not a scope.
  if (company && domain) {
    query.set('domain', domain)
  }
  return `/api/gtd/scorecard/attention${query.size > 0 ? `?${query.toString()}` : ''}`
}

/**
 * The signed bank-export read. It is the same transport posture as
 * `requestConsoleWorkflow` — same person capture, same redirect/cookie stance,
 * same re-check that the connection did not change under the request — and
 * differs only in that the body is CSV text, so it cannot be JSON-parsed.
 */
async function transactionsCsv(
  company: AccountingCompany
): Promise<ConsoleWorkflowResult<{ company: AccountingCompany; filename: string; csv: string }>> {
  const path = `/api/accounting/${company}/transactions.csv`
  try {
    const captured = await captureConsoleWorkflowPerson()
    if (!captured.ok) {
      return captured
    }
    const { bearer, baseUrl, isCurrent } = captured.data
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(30_000),
      headers: { accept: 'text/csv', Authorization: `Bearer ${bearer}` }
    })
    // Why: undici can crash the process on a body no path ever reads (omni#8695),
    // and both refusals below return without reading this one.
    if (!isCurrent()) {
      await cancelUnreadResponseBody(response)
      return failure(
        'connection_changed',
        'The signed-in person or connection changed; refresh before continuing.'
      )
    }
    if (!response.ok) {
      await cancelUnreadResponseBody(response)
      return failure(
        response.status === 401
          ? 'signed_in_required'
          : response.status === 403
            ? 'forbidden'
            : 'backoffice_refused',
        `The bank export was refused (HTTP ${response.status}).`,
        response.status
      )
    }
    const csv = await readFetchResponseTextWithinLimit(response, CSV_MAX_BYTES).catch(
      async (reason: unknown) => {
        // A body over the cap leaves the rest unread; cancel it before giving up.
        await cancelUnreadResponseBody(response)
        throw reason
      }
    )
    if (!isCurrent()) {
      return failure(
        'connection_changed',
        'The signed-in person or connection changed; refresh before continuing.'
      )
    }
    return {
      ok: true,
      data: accountingTransactionsCsv.parse({
        company,
        filename: `${company}-bank-transactions.csv`,
        csv
      })
    }
  } catch {
    // An exception can carry the URL, the body or the live credential.
    return failure(
      'backoffice_unavailable',
      'The backoffice could not be reached. Try the export again.'
    )
  }
}

/**
 * Sal's companies view, read through the desktop's signed backoffice transport:
 * the estate rollup and one company's cockpit, the org tree, the scorecard's
 * judgement and the company's finances. The only write is the bank refresh a
 * person asks for.
 */
export const consoleCompaniesClient: ConsoleCompaniesApi = {
  rollup: () => request('/api/estate/rollup', 'GET', estateRollup),
  // The money scorecard is one document for every company; the relay prunes it
  // to the person's company scope and drops the estate totals when it does.
  scorecard: () => request('/api/gtd/estate/scorecard', 'GET', scorecardDocument),
  // Who is signed in and which companies the console lets them read.
  me: () => request('/api/me', 'GET', consoleMe),
  orgChart: () => request('/api/gtd/hub/api/orgchart', 'GET', orgChart),
  missions: () => request('/api/estate/missions', 'GET', estateMissions),
  today: () => request('/api/estate/today', 'GET', estateToday),
  org: () => request('/api/org', 'GET', orgView),
  folders: () => request('/api/work/folders', 'GET', workFolders),
  company: (args) =>
    validated(args, companyRequest, (input) =>
      request(
        `/api/estate/company/${input.companyId}`,
        'GET',
        // A routing or cache mix-up must never paint another company's work.
        estateCompany.refine((value) => value.company_id === input.companyId)
      )
    ),
  health: (args) =>
    validated(args, healthScope, (input) =>
      request(
        healthPath(input),
        'GET',
        companyHealthView.refine(
          (value) => !input.company || value.companies.every((row) => row.slug === input.company)
        )
      )
    ),
  accounting: (args) =>
    validated(args, accountingRequest, (input) =>
      request(
        `/api/accounting?company=${input.company}`,
        'GET',
        // The same rule the web console keeps: never show another company's money.
        accountingSnapshot.refine((value) => value.company === input.company)
      )
    ),
  syncAccounting: (args) =>
    validated(args, accountingRequest, (input) =>
      request(`/api/accounting/${input.company}/sync`, 'POST', accountingSyncReceipt, {})
    ),
  transactionsCsv: (args) =>
    validated(args, accountingRequest, (input) => transactionsCsv(input.company))
}
