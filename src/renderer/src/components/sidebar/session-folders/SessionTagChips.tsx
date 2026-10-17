import { useMemo } from 'react'
import { useSessionTags } from '@/store/session-tags'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { conversationViewKey } from '@/lib/conversation-view'
import { useSessionTagIds } from './use-session-tags'

/** How many dots fit beside a name before the rest collapse into "+n". */
const DOT_LIMIT = 3

/**
 * A session's tags. `dots` is the one-line form: colour alone, inline with the name, so a tagged
 * row stays exactly as tall as an untagged one — the names live in the title and the tag picker.
 * `chips` is the roomier form used where the row already spends more than one line.
 */
export function SessionTagChips({
  session,
  variant = 'chips'
}: {
  session: SidebarSession
  variant?: 'chips' | 'dots'
}) {
  const sessions = useMemo(() => [session], [session])
  const ids = useSessionTagIds(sessions).get(conversationViewKey(session)) ?? []
  const definitions = useSessionTags((state) => state.data.tags)
  const tags = definitions.filter((tag) => ids.includes(tag.id))
  if (!tags.length) {
    return null
  }
  if (variant === 'dots') {
    const shown = tags.slice(0, DOT_LIMIT)
    const rest = tags.slice(DOT_LIMIT)
    return (
      <span
        className="flex shrink-0 items-center gap-0.5"
        title={tags.map((tag) => tag.name).join(', ')}
        data-session-tag-dots={tags.length}
      >
        {shown.map((tag) => (
          <span
            key={tag.id}
            aria-label={tag.name}
            data-session-tag-dot={tag.name}
            // Why a ring: a pale tag must still read as a dot on the row's hover fill.
            className="size-2 shrink-0 rounded-full ring-1 ring-inset ring-foreground/20"
            style={{ backgroundColor: tag.color }}
          />
        ))}
        {rest.length ? (
          <span className="text-[10px] font-normal leading-none text-muted-foreground">
            +{rest.length}
          </span>
        ) : null}
      </span>
    )
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {tags.slice(0, 2).map((tag) => (
        <span
          key={tag.id}
          title={tag.name}
          className="inline-flex max-w-24 items-center gap-1 rounded-full border px-1.5 text-[11px] font-normal leading-4 text-foreground"
          style={{
            borderColor: `color-mix(in srgb, ${tag.color} 45%, var(--border))`,
            backgroundColor: `color-mix(in srgb, ${tag.color} 12%, var(--background))`
          }}
        >
          <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
          <span className="truncate">{tag.name}</span>
        </span>
      ))}
      {tags.length > 2 ? (
        <span
          className="text-[11px] font-normal text-muted-foreground"
          title={tags
            .slice(2)
            .map((tag) => tag.name)
            .join(', ')}
        >
          +{tags.length - 2}
        </span>
      ) : null}
    </span>
  )
}
