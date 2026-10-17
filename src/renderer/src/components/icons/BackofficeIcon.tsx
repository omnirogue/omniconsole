// The OmniConsole OC mark (ring + C + prompt dot), monochrome via currentColor.
export function BackofficeIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 512 512" fill="none" className={className} aria-hidden="true">
      <circle cx="256" cy="256" r="196" stroke="currentColor" strokeWidth="46" />
      <path
        d="M 325.6 173.3 A 108 108 0 1 0 325.6 338.7"
        stroke="currentColor"
        strokeWidth="46"
        strokeLinecap="round"
      />
      <circle cx="364" cy="256" r="27" fill="currentColor" />
    </svg>
  )
}
