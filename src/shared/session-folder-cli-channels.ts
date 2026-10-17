// Why a file of its own: the preload imports these, and must not pull zod in with the contract.

/** Main → renderer: list or change the Conversations sidebar folders. */
export const SESSION_FOLDERS_REQUEST_CHANNEL = 'sessionFolders:request'
/** Renderer → main: the answer to one request, by request id. */
export const SESSION_FOLDERS_REPLY_CHANNEL = 'sessionFolders:reply'
/** Renderer → main: synchronous, one-shot durable archive decision. */
export const SESSION_TRANSFER_ARCHIVE_COMMIT_CHANNEL = 'sessionTransfer:archiveCommit'

export const SESSION_TRANSFER_ARCHIVE_PENDING_CHANNEL = 'sessionTransfer:archivePending'
export const SESSION_TRANSFER_ARCHIVE_APPLIED_CHANNEL = 'sessionTransfer:archiveApplied'
export type TransferArchiveProjection = { operationId: string; keys: string[] }
/** Renderer → main: the project mirror main answers from while no window is open. */
export const SESSION_PROJECT_MIRROR_CHANNEL = 'sessionProjects:mirror'
