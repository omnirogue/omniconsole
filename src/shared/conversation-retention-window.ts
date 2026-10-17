/**
 * How long a finished conversation stays visible. Both the sidebar's grouping and the
 * chain records it reads from use these, so an archived row can still say who it was
 * handed to instead of losing its plan on the next restart.
 */
export const CONVERSATION_COMPLETED_AFTER_MS = 10 * 60_000
export const CONVERSATION_ARCHIVED_AFTER_MS = 10 * 60 * 60_000
