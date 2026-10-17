// OmniConsole: saving a hub task publication into the session journal.
//
// Before upstream #18652 this mutated the reducer state and forced a JSONL
// snapshot compaction to make it durable. SQLite replay has no snapshot, so the
// publication is now an ordinary append-only row: `journalTaskPublicationRowBuilder`
// validates it against what is already saved, the row writer makes it durable in
// the same serialized transaction as every other append, and replay folds it back
// through the reducer.

export {
  isJournalTaskPublication,
  type JournalTaskPublication
} from './journal-task-publication-schema'
export { assertTaskPublicationSave, nextTaskPublications } from './journal-task-publication-state'
