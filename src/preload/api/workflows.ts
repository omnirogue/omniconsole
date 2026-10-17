import type { IpcRenderer } from 'electron'
import {
  DISCOVER_CREDIT_QUOTE_CHANNEL,
  type DiscoverCreditQuoteRequest,
  type DiscoverCreditQuoteResult
} from '../../shared/discover-credit-quote-ipc'

export type WorkflowScriptApi = {
  quoteDiscoverCredits: (request: DiscoverCreditQuoteRequest) => Promise<DiscoverCreditQuoteResult>
}

export function createWorkflowScriptApi(ipc: Pick<IpcRenderer, 'invoke'>): WorkflowScriptApi {
  return {
    quoteDiscoverCredits: (request) => ipc.invoke(DISCOVER_CREDIT_QUOTE_CHANNEL, request)
  }
}
