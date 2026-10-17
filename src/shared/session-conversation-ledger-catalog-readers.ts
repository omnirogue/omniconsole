/**
 * The owner's folder catalog and project list on the conversation ledger, read leniently: known
 * keys only, bounded, each id once; project settings (instructions, attachments) are never read.
 * Kept apart so the readers module stays within max-lines.
 */

import {
  SESSION_CONVERSATION_LEDGER_LIMITS,
  type SessionConversationLedgerFolder,
  type SessionConversationLedgerProject
} from './session-conversation-ledger-contract'
import { asObject, boundedText } from './session-conversation-ledger-read-primitives'

const {
  folderName: MAX_FOLDER_NAME,
  folders: MAX_FOLDERS,
  projects: MAX_PROJECTS,
  id: MAX_ID
} = SESSION_CONVERSATION_LEDGER_LIMITS

export function readSessionConversationLedgerFolders(
  value: unknown
): SessionConversationLedgerFolder[] {
  const folders: SessionConversationLedgerFolder[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(value) ? value.slice(0, MAX_FOLDERS) : []) {
    const raw = asObject(entry)
    const id = raw ? boundedText(raw.id, MAX_ID) : null
    const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, MAX_FOLDER_NAME) : ''
    if (!id || !name || seen.has(id)) {
      continue
    }
    seen.add(id)
    const parentId = boundedText(raw?.parentId, MAX_ID)
    const section = raw?.section === 'saved' || raw?.section === 'active' ? raw.section : null
    folders.push({ id, name, ...(parentId ? { parentId } : {}), ...(section ? { section } : {}) })
  }
  return folders
}

export function readSessionConversationLedgerProjects(
  value: unknown
): SessionConversationLedgerProject[] {
  const projects: SessionConversationLedgerProject[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(value) ? value.slice(0, MAX_PROJECTS) : []) {
    const raw = asObject(entry)
    const folderId = raw ? boundedText(raw.folderId, MAX_ID) : null
    if (!folderId || seen.has(folderId)) {
      continue
    }
    seen.add(folderId)
    const displayName =
      typeof raw?.displayName === 'string' ? raw.displayName.trim().slice(0, MAX_FOLDER_NAME) : ''
    projects.push({ folderId, ...(displayName ? { displayName } : {}) })
  }
  return projects
}
