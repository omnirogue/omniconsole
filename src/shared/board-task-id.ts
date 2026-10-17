/**
 * The one spelling of a hub board card id. Every transport route, the complete/archive
 * verbs and the omni:// deep link accept exactly this shape, so a card the hub mints
 * can be created, sent, completed, archived and linked alike.
 */
export const BOARD_TASK_ID_PATTERN = /^btk_[A-Za-z0-9]{4,64}$/

export function isBoardTaskId(value: unknown): value is string {
  return typeof value === 'string' && BOARD_TASK_ID_PATTERN.test(value)
}
