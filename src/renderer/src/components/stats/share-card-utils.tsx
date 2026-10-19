import type {
  ClaudeUsageDailyPoint,
  ClaudeUsageSummary
} from '../../../../shared/claude-usage-types'
import type { CodexUsageDailyPoint, CodexUsageSummary } from '../../../../shared/codex-usage-types'
import { translate } from '@/i18n/i18n'
import { OMNI_PROJECT_REPO_DISPLAY_URL } from '../../../../shared/omni-project-repo'

export type ClaudeShareData = {
  provider: 'claude'
  summary: ClaudeUsageSummary
  daily: ClaudeUsageDailyPoint[]
}

export type CodexShareData = {
  provider: 'codex'
  summary: CodexUsageSummary
  daily: CodexUsageDailyPoint[]
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`
  }
  return value.toLocaleString()
}

export function formatCost(value: number | null): string {
  if (value === null) {
    return 'n/a'
  }
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

export function formatDateRange(range: string): string {
  const now = new Date()
  const end = now.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  if (range === 'all') {
    return `Through ${end}`
  }
  const days = Number.parseInt(range)
  if (Number.isNaN(days)) {
    return end
  }
  const start = new Date(now.getTime() - days * 86_400_000)
  const startStr = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return `${startStr} – ${end}`
}

export const RANGE_LABELS: Record<string, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  all: 'All time'
}

export function getDailyTotal(entry: ClaudeUsageDailyPoint | CodexUsageDailyPoint): number {
  if ('cacheReadTokens' in entry) {
    return entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens
  }
  return entry.totalTokens
}

export type DailySegment = { key: string; value: number; color: string }

export function getDailySegments(
  entry: ClaudeUsageDailyPoint | CodexUsageDailyPoint
): DailySegment[] {
  // Why: segment order matches the original charts exactly (top-to-bottom).
  // Segments render as stacked block divs in a table cell with vertical-align: bottom.
  if ('cacheReadTokens' in entry) {
    return [
      { key: 'cache-write', value: entry.cacheWriteTokens, color: 'rgba(217, 70, 239, 0.7)' },
      { key: 'cache-read', value: entry.cacheReadTokens, color: 'rgba(251, 191, 36, 0.7)' },
      { key: 'output', value: entry.outputTokens, color: 'rgba(52, 211, 153, 0.8)' },
      { key: 'input', value: entry.inputTokens, color: 'rgba(56, 189, 248, 0.8)' }
    ]
  }
  return [
    { key: 'input', value: entry.inputTokens, color: 'rgba(56, 189, 248, 0.8)' },
    { key: 'output', value: entry.outputTokens, color: 'rgba(52, 211, 153, 0.8)' },
    { key: 'cached', value: entry.cachedInputTokens, color: 'rgba(251, 191, 36, 0.7)' },
    { key: 'reasoning', value: entry.reasoningOutputTokens, color: 'rgba(217, 70, 239, 0.7)' }
  ]
}

export function getLegendItems(provider: 'claude' | 'codex') {
  if (provider === 'claude') {
    return [
      {
        label: translate('auto.components.stats.share.card.utils.c2d7b23d57', 'Input'),
        color: 'rgba(56, 189, 248, 0.8)'
      },
      {
        label: translate('auto.components.stats.share.card.utils.33d38e2177', 'Output'),
        color: 'rgba(52, 211, 153, 0.8)'
      },
      {
        label: translate('auto.components.stats.share.card.utils.cc28cb965e', 'Cache read'),
        color: 'rgba(251, 191, 36, 0.7)'
      },
      {
        label: translate('auto.components.stats.share.card.utils.9d166247ee', 'Cache write'),
        color: 'rgba(217, 70, 239, 0.7)'
      }
    ]
  }
  return [
    {
      label: translate('auto.components.stats.share.card.utils.c2d7b23d57', 'Input'),
      color: 'rgba(56, 189, 248, 0.8)'
    },
    {
      label: translate('auto.components.stats.share.card.utils.33d38e2177', 'Output'),
      color: 'rgba(52, 211, 153, 0.8)'
    },
    {
      label: translate('auto.components.stats.share.card.utils.4ee864629a', 'Cached input'),
      color: 'rgba(251, 191, 36, 0.7)'
    },
    {
      label: translate('auto.components.stats.share.card.utils.7080aeaebb', 'Reasoning'),
      color: 'rgba(217, 70, 239, 0.7)'
    }
  ]
}

export function OrcaLogo(): React.JSX.Element {
  return (
    <svg
      width={26}
      height={26}
      viewBox="1440 1554 17600 17600"
      xmlns="http://www.w3.org/2000/svg"
      style={{ opacity: 0.9, verticalAlign: 'middle' }}
    >
      <path
        transform="matrix(1 0 0 -1 0 20480)"
        fill="#ffffff"
        d="M17356 18238 c-28 -43 -36 -114 -46 -391 -5 -153 -11 -281 -14 -285 -2 -4 -12 -106 -21 -227 -87 -1155 -376 -2063 -951 -2985 -511 -818 -1509 -1762 -2514 -2377 -63 -39 -204 -128 -313 -199 -108 -71 -256 -165 -328 -209 -946 -578 -1595 -1089 -2048 -1615 -64 -74 -159 -184 -212 -245 -146 -167 -234 -284 -397 -528 -260 -388 -291 -391 -515 -58 -334 497 -838 1063 -1257 1412 -557 465 -862 676 -1855 1282 -1474 900 -2467 1892 -3038 3034 -152 302 -348 822 -421 1113 -167 668 -219 1044 -256 1855 -13 284 -27 364 -72 413 -61 64 -129 -7 -204 -214 -19 -55 -66 -165 -104 -245 -436 -926 -761 -2193 -830 -3239 -6 -91 -18 -253 -27 -360 -40 -472 1 -1440 83 -1980 91 -596 259 -1306 436 -1840 274 -828 669 -1730 1001 -2285 707 -1182 2010 -2610 3396 -3720 528 -424 685 -543 1201 -912 107 -76 274 -195 370 -264 347 -249 951 -666 1299 -898 101 -68 220 -150 265 -183 186 -139 245 -137 489 21 67 43 196 124 287 180 90 56 239 154 330 217 401 277 617 426 775 534 583 398 1235 876 1576 1157 75 61 208 167 295 234 181 139 283 223 433 359 58 53 169 150 246 215 441 377 1297 1266 1726 1795 292 359 810 1109 1045 1512 345 592 721 1511 930 2268 25 91 72 260 104 375 53 187 137 568 205 925 130 689 179 1946 100 2570 -8 63 -31 268 -50 455 -92 879 -391 1984 -748 2765 -41 91 -94 217 -117 280 -93 254 -198 373 -254 288z m-965 -6608 c56 -31 60 -100 23 -410 -113 -954 -328 -1508 -830 -2140 -507 -639 -1069 -994 -1999 -1264 -489 -141 -696 -184 -1315 -272 -390 -55 -408 -69 -688 -526 -66 -106 -144 -231 -174 -278 -30 -47 -127 -204 -215 -350 -88 -146 -237 -385 -331 -532 -94 -147 -205 -327 -248 -400 -255 -440 -296 -500 -357 -516 -78 -21 -125 21 -233 209 -85 149 -225 379 -384 629 -162 256 -435 695 -542 874 -49 81 -129 207 -177 280 -48 72 -120 187 -161 256 -145 246 -214 290 -540 339 -580 88 -821 135 -1095 214 -104 31 -228 65 -275 77 -1157 293 -2026 1043 -2483 2141 -141 339 -232 694 -271 1059 -55 523 -55 536 -11 584 66 72 149 30 610 -308 59 -43 529 -351 655 -429 214 -132 576 -340 770 -442 124 -65 290 -154 369 -198 79 -44 254 -134 389 -200 498 -243 629 -316 1122 -625 272 -171 364 -236 625 -445 353 -283 673 -595 935 -915 296 -361 369 -453 443 -557 207 -293 231 -286 572 160 336 440 385 496 744 860 357 363 597 562 936 777 559 354 877 537 1152 662 216 98 1028 516 1283 661 80 45 195 109 255 142 178 97 674 418 900 582 72 52 185 134 252 183 167 121 236 149 294 118z"
      />
    </svg>
  )
}

export function BackgroundGlows(): React.JSX.Element {
  return (
    <>
      <div
        style={{
          position: 'absolute',
          top: '-60%',
          right: '-20%',
          width: 300,
          height: 300,
          background: 'radial-gradient(circle, rgba(20, 71, 230, 0.08) 0%, transparent 70%)',
          pointerEvents: 'none'
        }}
      />
      <div
        style={{
          position: 'absolute',
          bottom: '-40%',
          left: '-10%',
          width: 250,
          height: 250,
          background: 'radial-gradient(circle, rgba(139, 92, 246, 0.05) 0%, transparent 70%)',
          pointerEvents: 'none'
        }}
      />
    </>
  )
}

export function CardFooter(props: {
  summary: { inputTokens: number; outputTokens: number }
}): React.JSX.Element {
  return (
    <div
      style={{
        display: 'table',
        width: '100%',
        marginTop: 16,
        paddingTop: 12,
        borderTop: '1px solid rgba(255, 255, 255, 0.05)',
        position: 'relative',
        zIndex: 1
      }}
    >
      <div style={{ display: 'table-cell', verticalAlign: 'middle' }}>
        <span style={{ fontSize: 12, color: '#888' }}>
          <strong style={{ color: '#ccc' }}>{formatTokens(props.summary.inputTokens)}</strong>{' '}
          {translate('auto.components.stats.share.card.utils.5d66fdd7c2', 'input')}
        </span>
        <span style={{ fontSize: 12, color: '#888', marginLeft: 16 }}>
          <strong style={{ color: '#ccc' }}>{formatTokens(props.summary.outputTokens)}</strong>{' '}
          {translate('auto.components.stats.share.card.utils.d864fc5f98', 'output')}
        </span>
      </div>
      <div style={{ display: 'table-cell', verticalAlign: 'middle', textAlign: 'right' }}>
        <span style={{ display: 'inline-block', verticalAlign: 'middle' }}>
          <GitHubIcon />
        </span>
        <span
          style={{
            fontSize: 11,
            color: '#888',
            letterSpacing: 0.2,
            verticalAlign: 'middle',
            marginLeft: 5
          }}
        >
          {OMNI_PROJECT_REPO_DISPLAY_URL}
        </span>
      </div>
    </div>
  )
}

function GitHubIcon(): React.JSX.Element {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 16 16"
      fill="#888"
      style={{ opacity: 0.6, verticalAlign: 'middle' }}
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}
