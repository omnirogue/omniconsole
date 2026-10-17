import { cn } from '@/lib/utils'

/**
 * Hover-only row controls. On a pointer that can hover they take no width at rest, so the name
 * keeps the row; they open on hover, while focus is inside them (they stay focusable while
 * folded, so Tab reaches them and unfolds them), while one of the row's buttons has keyboard
 * focus, while a popover opened from the row is up (its anchor must not move: neither its own
 * group nor one beside it may fold once the pointer or focus goes into it), or while the owner
 * pins them (`data-pinned`, on them or inside). Touch shows them always.
 * Why not any focus in the row: a clicked row with no pane to focus (a workflow) keeps focus on
 * its own Open button, which would hold them open and squeeze the name back to nothing; and the
 * rename field (always `:focus-visible`) keeps the whole width while someone types.
 * Why literal class names: Tailwind only generates classes it can read verbatim in the source.
 */
export const ROW_HOVER_REVEAL = cn(
  'flex items-center',
  'can-hover:max-w-0 can-hover:overflow-clip can-hover:opacity-0 can-hover:transition-opacity',
  'group-hover:max-w-none group-hover:overflow-visible group-hover:opacity-100',
  'focus-within:max-w-none focus-within:overflow-visible focus-within:opacity-100',
  'group-has-[button:focus-visible]:max-w-none group-has-[button:focus-visible]:overflow-visible',
  'group-has-[button:focus-visible]:opacity-100',
  'has-[[aria-haspopup][aria-expanded=true]]:max-w-none',
  'has-[[aria-haspopup][aria-expanded=true]]:overflow-visible',
  'has-[[aria-haspopup][aria-expanded=true]]:opacity-100',
  'group-has-[[aria-haspopup][aria-expanded=true]]:max-w-none',
  'group-has-[[aria-haspopup][aria-expanded=true]]:overflow-visible',
  'group-has-[[aria-haspopup][aria-expanded=true]]:opacity-100',
  'data-[pinned]:max-w-none data-[pinned]:overflow-visible data-[pinned]:opacity-100',
  'has-[[data-pinned]]:max-w-none has-[[data-pinned]]:overflow-visible has-[[data-pinned]]:opacity-100'
)

/**
 * The open button's floor while the controls show: about 4.5rem of name beside the glyph and the ✎
 * (`--row-name-floor`; a workflow row's second glyph raises it, `ROW_NAME_FLOOR_WORKFLOW`). Why:
 * the controls take about 150 of a 255 px row on hover, which squeezed a floorless name to 0 px,
 * and a 6.5rem floor still left a row nested in a folder showing one letter.
 * - It never pushes the row's fixed controls past its edge (`--row-name-reserve`: the checkbox and
 *   ⋮ ＋ or lock and ✕, plus the details chevron and a ready plan's ▶ only on rows that have
 *   them); a narrow sidebar shortens the name.
 * - A keyboard-focused put-away control takes 1.5rem per place from it (`--row-name-give`), so
 *   that control shows without the name dropping to nothing; an open Tags popover keeps the most
 *   room, so its anchor stays where it was opened.
 */
export const ROW_NAME_FLOOR = cn(
  '[--row-name-give:0rem] [--row-name-reserve:5.125rem]',
  'group-has-[[data-session-row-expand]]:[--row-name-reserve:6.625rem]',
  'group-has-[[data-session-row-start]]:[--row-name-reserve:6.625rem]',
  'group-has-[[data-session-row-start]]:group-has-[[data-session-row-expand]]:[--row-name-reserve:8.125rem]',
  'min-w-[min(calc(var(--row-name-floor,8.5rem)_-_var(--row-name-give)),calc(100%_-_var(--row-name-reserve)_-_var(--row-name-give)))]',
  'group-has-[[data-session-row-yield]>:nth-child(1):focus-visible]:[--row-name-give:1.5rem]',
  'group-has-[[data-session-row-yield]>:nth-child(2):focus-visible]:[--row-name-give:3rem]',
  'group-has-[[data-session-row-yield]>:nth-child(3):focus-visible]:[--row-name-give:4.5rem]',
  'group-has-[[data-session-row-yield]>[aria-expanded=true]]:[--row-name-give:4.5rem]'
)

/** A workflow row's floor: its preset glyph and gap (1.125rem) sit beside the state glyph. */
export const ROW_NAME_FLOOR_WORKFLOW = '[--row-name-floor:9.625rem]'

/**
 * Hide, Archive and Tags: hover-only icons (1.5rem each), and what gives way to the name's floor.
 * A control that does not fit wraps onto a line the fixed height clips, so it folds away whole,
 * from the end; the empty `before:` item keeps the first line from holding one (a flex line always
 * takes its first). Why never unwrapped for focus: the floor makes room for the focused control,
 * and the ones after it that still do not fit must stay folded rather than draw over the name.
 * An open popover unwraps it, so its trigger cannot drop to the clipped line under the popover.
 */
export const ROW_HOVER_YIELD = cn(
  'flex h-6 min-w-0 flex-wrap content-start items-center justify-end',
  "before:h-6 before:content-['']",
  'overflow-clip [overflow-clip-margin:3px]',
  'can-hover:max-w-0 can-hover:opacity-0 can-hover:transition-opacity',
  'group-hover:max-w-none group-hover:opacity-100',
  'focus-within:max-w-none focus-within:opacity-100',
  'group-has-[button:focus-visible]:max-w-none group-has-[button:focus-visible]:opacity-100',
  'has-[[aria-haspopup][aria-expanded=true]]:max-w-none',
  'has-[[aria-haspopup][aria-expanded=true]]:opacity-100',
  'has-[[aria-haspopup][aria-expanded=true]]:flex-nowrap',
  'has-[[aria-haspopup][aria-expanded=true]]:overflow-visible'
)

/** The compact row's resting mark steps aside whenever the controls above open. */
export const ROW_REST_MARK = cn(
  'group-hover:hidden group-has-[button:focus-visible]:hidden [@media(hover:none)]:hidden',
  'group-has-[[data-session-row-actions]:focus-within]:hidden',
  'group-has-[[aria-haspopup][aria-expanded=true]]:hidden group-has-[[data-pinned]]:hidden'
)
