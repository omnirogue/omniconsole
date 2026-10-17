/**
 * A paired owner's paused or stopped conversation, as muted text after its name ("paused on Mac
 * Studio", session parity step 6). It names the computer too, so it stands in for the host label.
 */
export function SessionRowRestLabel({ label }: { label: string }): React.JSX.Element {
  return (
    <span
      className="ml-1.5 min-w-[3ch] max-w-[45%] shrink-[100] truncate text-[11px] font-normal text-muted-foreground"
      data-session-rest-label=""
      title={label}
    >
      {label}
    </span>
  )
}
