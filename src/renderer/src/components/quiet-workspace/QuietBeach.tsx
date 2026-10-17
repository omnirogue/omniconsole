/** A still illustration: no network request, motion, audio, or session content. */
export function QuietBeach() {
  return (
    <svg
      className="absolute inset-0 size-full"
      viewBox="0 0 1200 800"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <rect width="1200" height="800" fill="var(--quiet-sky)" />
      <circle cx="880" cy="170" r="55" fill="var(--quiet-sun)" />
      <path d="M0 385 Q350 370 650 388 T1200 382 V800 H0Z" fill="var(--quiet-sea)" />
      <path d="M0 535 Q340 455 685 542 T1200 518 V800 H0Z" fill="var(--quiet-shore)" />
      <path d="M0 553 Q340 473 685 560 T1200 536 V800 H0Z" fill="var(--quiet-sand)" />
      <g fill="none" stroke="var(--quiet-shore)" strokeWidth="2" opacity=".45">
        <path d="M380 428 Q560 416 740 430 M760 463 Q910 450 1080 459 M90 470 Q190 456 300 461" />
      </g>
      <path
        d="M134 800 Q201 501 157 278 L176 274 Q240 498 176 800Z"
        fill="var(--quiet-palm-trunk)"
      />
      <g fill="var(--quiet-palm)">
        <path d="M169 285 Q25 194 -90 324 Q63 276 169 285Z" />
        <path d="M169 285 Q23 119 -78 187 Q70 194 169 285Z" />
        <path d="M169 285 Q97 103 163 67 Q191 170 169 285Z" />
        <path d="M169 285 Q232 100 370 148 Q249 190 169 285Z" />
        <path d="M169 285 Q333 155 447 272 Q295 243 169 285Z" />
        <path d="M169 285 Q348 257 381 399 Q274 306 169 285Z" />
      </g>
    </svg>
  )
}
