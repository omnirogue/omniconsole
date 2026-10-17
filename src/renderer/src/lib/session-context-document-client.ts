import type {
  ResolveContextDocumentRequest,
  ResolveContextDocumentResult,
  SearchContextDocumentsRequest,
  SearchContextDocumentsResult
} from '../../../shared/session-context-documents'
import { callRuntimeRpc, hasRuntimeRpcErrorCode } from '@/runtime/runtime-rpc-client'

async function readDocuments<T extends SearchContextDocumentsResult | ResolveContextDocumentResult>(
  method: string,
  request: SearchContextDocumentsRequest | ResolveContextDocumentRequest
): Promise<T | { status: 'error'; message: string }> {
  try {
    // Credentials belong to this desktop; session execution may be on a different computer.
    return await callRuntimeRpc<T>({ kind: 'local' }, method, request)
  } catch (error) {
    return {
      status: 'error',
      message: hasRuntimeRpcErrorCode(error, 'method_not_found')
        ? 'Update OmniConsole on this computer to search and attach documents.'
        : 'Document search could not be reached. Try again.'
    }
  }
}

export function searchContextDocuments(
  request: SearchContextDocumentsRequest
): Promise<SearchContextDocumentsResult> {
  return readDocuments<SearchContextDocumentsResult>('artifacts.searchContextDocuments', request)
}

export function resolveContextDocument(
  request: ResolveContextDocumentRequest
): Promise<ResolveContextDocumentResult> {
  return readDocuments<ResolveContextDocumentResult>('artifacts.resolveContextDocument', request)
}
