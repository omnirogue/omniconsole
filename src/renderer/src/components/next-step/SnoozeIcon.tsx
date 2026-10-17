/** A clock with a sleeping Z distinguishes attention snooze from a scheduled delay. */
export function SnoozeIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 4a8 8 0 1 0 8 8M12 8v4l-3 2M16 3h5l-5 5h5" />
    </svg>
  )
}
