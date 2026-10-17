import { qboStatus, type ConsoleQuickBooksApi } from '../../shared/console-quickbooks-contract'
import { requestConsoleWorkflow as request } from './console-workflow-transport'

/**
 * The books connection, read through the signed transport. One operation, a GET.
 *
 * There is deliberately no write here. Authorizing a QuickBooks company is an OAuth
 * consent only a person can give in a browser, and choosing ledger accounts or forcing a
 * re-check each change what the books report — so each needs its own reviewed operation
 * rather than riding in on a status read.
 */
export const consoleQuickBooksClient: ConsoleQuickBooksApi = {
  status: () =>
    request(
      '/api/accounting/connections/quickbooks',
      'GET',
      // A routing mix-up must never show another provider's connection as the books.
      qboStatus.refine(
        (value) => value.provider === 'quickbooks',
        'This connection belongs to a different provider.'
      )
    )
}
