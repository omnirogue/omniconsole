import { translate } from '@/i18n/i18n'
import type { SessionGroupParityCounts } from './session-group-parity'

const BADGE =
  'inline-flex shrink-0 items-center rounded-full bg-muted px-1.5 text-[10px] tabular-nums leading-4 text-muted-foreground'

/**
 * Session parity (step 8): beside a heading's headline, the rows it leaves out — listed only on
 * this computer with nothing current vouching for them, and captures their owner holds without
 * listing (G1). Each is still a row below; nothing is hidden, only counted apart.
 */
export function SessionGroupParityBadges({
  onlyHere,
  held
}: SessionGroupParityCounts): React.JSX.Element {
  const onlyHereText = translate(
    'conversations.parity.onlyHere',
    "+{{count}} only here (can't verify)",
    {
      count: onlyHere
    }
  )
  const heldText = translate('conversations.parity.heldByOwner', '+{{count}} held by owner', {
    count: held
  })
  return (
    <>
      {onlyHere > 0 ? (
        <span data-session-group-only-here={onlyHere} title={onlyHereText} className={BADGE}>
          {onlyHereText}
        </span>
      ) : null}
      {held > 0 ? (
        <span data-session-group-held={held} title={heldText} className={BADGE}>
          {heldText}
        </span>
      ) : null}
    </>
  )
}
