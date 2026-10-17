import {
  SESSION_SEARCH_MARK_CLOSE,
  SESSION_SEARCH_MARK_OPEN
} from '../../../../../shared/session-search-types'

const MARKED = new RegExp(
  `${SESSION_SEARCH_MARK_OPEN}(.*?)${SESSION_SEARCH_MARK_CLOSE}|([^${SESSION_SEARCH_MARK_OPEN}${SESSION_SEARCH_MARK_CLOSE}]+)`,
  'g'
)

/** The passage that matched a search, on one line, with the matching words marked. */
export function SessionSearchPreviewLine({ text }: { text: string }): React.JSX.Element {
  const parts = [...text.replace(/\s+/g, ' ').matchAll(MARKED)]
  return (
    <span
      className="block truncate text-[11px] font-normal leading-snug text-muted-foreground"
      data-session-search-preview=""
    >
      {parts.map((part) =>
        part[1] !== undefined ? (
          <mark key={part.index} className="rounded-sm bg-accent px-0.5 text-foreground">
            {part[1]}
          </mark>
        ) : (
          <span key={part.index}>{part[2]}</span>
        )
      )}
    </span>
  )
}
