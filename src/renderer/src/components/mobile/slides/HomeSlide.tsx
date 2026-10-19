import { ClaudeIcon, OpenAIIcon } from '../../status-bar/icons'
import { cn } from '../../../lib/utils'
import { translate } from '@/i18n/i18n'

export function HomeSlide({ tapping }: { tapping: boolean }): React.JSX.Element {
  return (
    <div className="mp-device-screen">
      <div className="mp-app-topbar">
        <div className="mp-app-brand">
          <OrcaLogo />
          <span className="mp-app-brand-name">
            {translate('auto.components.mobile.slides.HomeSlide.5d94e8ddcc', 'OmniConsole')}
          </span>
        </div>
        <button
          type="button"
          className="mp-icon-button"
          aria-label={translate('auto.components.mobile.slides.HomeSlide.af761a0c0d', 'Settings')}
        >
          <SettingsIcon />
        </button>
      </div>

      <div className="mp-scroll-region">
        <div className="mp-greeting">
          <div className="mp-greeting-title">
            {translate('auto.components.mobile.slides.HomeSlide.c0e2e9dcd9', 'Welcome back')}
          </div>
        </div>

        <div className="mp-stat-row">
          <Stat
            value="1,284"
            label={translate(
              'auto.components.mobile.slides.HomeSlide.00a6903322',
              'Agents spawned'
            )}
          />
          <Stat
            value="142h"
            label={translate('auto.components.mobile.slides.HomeSlide.4a40af029b', 'Agent time')}
          />
          <Stat
            value="96"
            label={translate('auto.components.mobile.slides.HomeSlide.156db8a68a', 'PRs created')}
          />
        </div>

        <div className="mp-section-label">
          {translate('auto.components.mobile.slides.HomeSlide.2f1a1d10c4', 'Desktops')}
        </div>
        <div className={cn('mp-host-card', tapping && 'is-tapping')}>
          <div className="mp-host-icon">
            <DesktopIcon />
          </div>
          <div className="mp-host-main">
            <div className="mp-host-name">
              {translate('auto.components.mobile.slides.HomeSlide.19c212e25e', 'MacBook Pro')}
            </div>
            <div className="mp-host-meta">
              <span className="mp-status-dot is-green" />
              <span>
                {translate(
                  'auto.components.mobile.slides.HomeSlide.0bc1881bc4',
                  'Connected · 40 worktrees · 5 active'
                )}
              </span>
            </div>
          </div>
          <div className="mp-chevron-right">
            <ChevronIcon />
          </div>
        </div>
        <div className="mp-host-card">
          <div className="mp-host-icon is-dim">
            <DesktopIcon />
          </div>
          <div className="mp-host-main">
            <div className="mp-host-name is-dim">
              {translate('auto.components.mobile.slides.HomeSlide.091355da3d', 'M1 Mini · home')}
            </div>
            <div className="mp-host-meta">
              <span className="mp-status-dot is-muted" />
              <span>
                {translate('auto.components.mobile.slides.HomeSlide.cf3f98fa3f', 'Disconnected')}
              </span>
            </div>
          </div>
          <div className="mp-chevron-right">
            <ChevronIcon />
          </div>
        </div>

        <div className="mp-section-label" style={{ marginTop: 14 }}>
          {translate('auto.components.mobile.slides.HomeSlide.c791677f2f', 'Resume')}
        </div>
        <div className="mp-resume-card">
          <div className="mp-resume-icon">
            <ResumeIcon />
          </div>
          <div className="mp-host-main">
            <div className="mp-resume-title">
              {translate('auto.components.mobile.slides.HomeSlide.25d6e8a491', 'feat/mobile-page')}
            </div>
            <div className="mp-resume-sub">
              <span className="mp-repo-dot" style={{ background: '#3b82f6' }} />
              <span>
                {translate(
                  'auto.components.mobile.slides.HomeSlide.d33d7a9c29',
                  // Why: plain spaces (not &nbsp;) — React text nodes render HTML entities literally.
                  'omni  ·  feat/mobile-page'
                )}
              </span>
            </div>
          </div>
          <div className="mp-chevron-right">
            <ChevronIcon />
          </div>
        </div>

        <div className="mp-section-label" style={{ marginTop: 10 }}>
          {translate('auto.components.mobile.slides.HomeSlide.a4c3f7b7aa', 'Tasks')}
        </div>
        <div className="mp-task-home-card">
          <div className="mp-task-home-icon">
            <ListTodoIcon />
          </div>
          <div className="mp-host-main">
            <div className="mp-task-home-title">
              {translate('auto.components.mobile.slides.HomeSlide.a4c3f7b7aa', 'Tasks')}
            </div>
            <div className="mp-task-home-subtitle">
              {translate('auto.components.mobile.slides.HomeSlide.d047197480', 'GitHub · Linear')}
            </div>
          </div>
          <div
            className="mp-task-home-providers"
            aria-label={translate(
              'auto.components.mobile.slides.HomeSlide.0bad5b07c8',
              'GitHub and Linear'
            )}
          >
            <div className="mp-task-home-provider-button">
              <GithubIcon />
            </div>
            <div className="mp-task-home-provider-button">
              <LinearIcon />
            </div>
          </div>
          <div className="mp-chevron-right">
            <ChevronIcon />
          </div>
        </div>

        <div className="mp-section-label" style={{ marginTop: 14 }}>
          {translate('auto.components.mobile.slides.HomeSlide.0b00c98506', 'Quick Actions')}
        </div>
        <div className="mp-quick-actions">
          <div className="mp-quick-action">
            <div className="mp-quick-action-icon">
              <QrSmallIcon />
            </div>
            <div className="mp-quick-action-label">
              {translate('auto.components.mobile.slides.HomeSlide.4405f3c440', 'Pair Desktop')}
            </div>
          </div>
          <div className="mp-quick-action">
            <div className="mp-quick-action-icon">
              <PlusIcon />
            </div>
            <div className="mp-quick-action-label">
              {translate('auto.components.mobile.slides.HomeSlide.e27fdaee51', 'New Workspace')}
            </div>
          </div>
        </div>

        <div className="mp-section-label" style={{ marginTop: 14 }}>
          {translate('auto.components.mobile.slides.HomeSlide.8a350a4784', 'Account usage')}
        </div>
        <div className="mp-accounts-card">
          <AccountRow
            icon={<ClaudeIcon size={18} />}
            email="claude@stably.ai"
            sessionPct={42}
            weekPct={18}
          />
          <AccountRow
            icon={<OpenAIIcon size={18} />}
            email="codex@stably.ai"
            sessionPct={67}
            weekPct={31}
          />
        </div>
      </div>
    </div>
  )
}

function Stat({ value, label }: { value: string; label: string }): React.JSX.Element {
  return (
    <div className="mp-stat-card">
      <div className="mp-stat-value">{value}</div>
      <div className="mp-stat-label">{label}</div>
    </div>
  )
}

function AccountRow({
  icon,
  email,
  sessionPct,
  weekPct
}: {
  icon: React.ReactNode
  email: string
  sessionPct: number
  weekPct: number
}): React.JSX.Element {
  return (
    <div className="mp-accounts-row">
      <div className="mp-accounts-icon">{icon}</div>
      <div className="mp-accounts-info">
        <div className="mp-accounts-email">{email}</div>
        <div className="mp-accounts-bars">
          <UsageBar
            label={translate('auto.components.mobile.slides.HomeSlide.a3d5476811', '5h')}
            pct={sessionPct}
          />
          <UsageBar
            label={translate('auto.components.mobile.slides.HomeSlide.a7d9e2c44d', '7d')}
            pct={weekPct}
          />
        </div>
      </div>
    </div>
  )
}

function UsageBar({ label, pct }: { label: string; pct: number }): React.JSX.Element {
  return (
    <div className="mp-usage-bar">
      <div className="mp-usage-bar-label">{label}</div>
      <div className="mp-usage-bar-track">
        <div className="mp-usage-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function OrcaLogo(): React.JSX.Element {
  return (
    <svg className="mp-omni-logo" viewBox="1440 1554 17600 17600" fill="none" aria-hidden>
      <path
        transform="matrix(1 0 0 -1 0 20480)"
        fill="currentColor"
        d="M17356 18238 c-28 -43 -36 -114 -46 -391 -5 -153 -11 -281 -14 -285 -2 -4 -12 -106 -21 -227 -87 -1155 -376 -2063 -951 -2985 -511 -818 -1509 -1762 -2514 -2377 -63 -39 -204 -128 -313 -199 -108 -71 -256 -165 -328 -209 -946 -578 -1595 -1089 -2048 -1615 -64 -74 -159 -184 -212 -245 -146 -167 -234 -284 -397 -528 -260 -388 -291 -391 -515 -58 -334 497 -838 1063 -1257 1412 -557 465 -862 676 -1855 1282 -1474 900 -2467 1892 -3038 3034 -152 302 -348 822 -421 1113 -167 668 -219 1044 -256 1855 -13 284 -27 364 -72 413 -61 64 -129 -7 -204 -214 -19 -55 -66 -165 -104 -245 -436 -926 -761 -2193 -830 -3239 -6 -91 -18 -253 -27 -360 -40 -472 1 -1440 83 -1980 91 -596 259 -1306 436 -1840 274 -828 669 -1730 1001 -2285 707 -1182 2010 -2610 3396 -3720 528 -424 685 -543 1201 -912 107 -76 274 -195 370 -264 347 -249 951 -666 1299 -898 101 -68 220 -150 265 -183 186 -139 245 -137 489 21 67 43 196 124 287 180 90 56 239 154 330 217 401 277 617 426 775 534 583 398 1235 876 1576 1157 75 61 208 167 295 234 181 139 283 223 433 359 58 53 169 150 246 215 441 377 1297 1266 1726 1795 292 359 810 1109 1045 1512 345 592 721 1511 930 2268 25 91 72 260 104 375 53 187 137 568 205 925 130 689 179 1946 100 2570 -8 63 -31 268 -50 455 -92 879 -391 1984 -748 2765 -41 91 -94 217 -117 280 -93 254 -198 373 -254 288z m-965 -6608 c56 -31 60 -100 23 -410 -113 -954 -328 -1508 -830 -2140 -507 -639 -1069 -994 -1999 -1264 -489 -141 -696 -184 -1315 -272 -390 -55 -408 -69 -688 -526 -66 -106 -144 -231 -174 -278 -30 -47 -127 -204 -215 -350 -88 -146 -237 -385 -331 -532 -94 -147 -205 -327 -248 -400 -255 -440 -296 -500 -357 -516 -78 -21 -125 21 -233 209 -85 149 -225 379 -384 629 -162 256 -435 695 -542 874 -49 81 -129 207 -177 280 -48 72 -120 187 -161 256 -145 246 -214 290 -540 339 -580 88 -821 135 -1095 214 -104 31 -228 65 -275 77 -1157 293 -2026 1043 -2483 2141 -141 339 -232 694 -271 1059 -55 523 -55 536 -11 584 66 72 149 30 610 -308 59 -43 529 -351 655 -429 214 -132 576 -340 770 -442 124 -65 290 -154 369 -198 79 -44 254 -134 389 -200 498 -243 629 -316 1122 -625 272 -171 364 -236 625 -445 353 -283 673 -595 935 -915 296 -361 369 -453 443 -557 207 -293 231 -286 572 160 336 440 385 496 744 860 357 363 597 562 936 777 559 354 877 537 1152 662 216 98 1028 516 1283 661 80 45 195 109 255 142 178 97 674 418 900 582 72 52 185 134 252 183 167 121 236 149 294 118z"
      />
    </svg>
  )
}

function SettingsIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  )
}

function DesktopIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
    </svg>
  )
}

function ChevronIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

function ResumeIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="m4 17 6-6-6-6" />
      <path d="M12 19h8" />
    </svg>
  )
}

function ListTodoIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <rect x="3" y="5" width="6" height="6" rx="1" />
      <path d="m3 17 2 2 4-4" />
      <path d="M13 6h8" />
      <path d="M13 12h8" />
      <path d="M13 18h8" />
    </svg>
  )
}

function GithubIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  )
}

function LinearIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 100 100" fill="currentColor" aria-hidden>
      <path d="M1.225 61.523c-.187-.738.708-1.235 1.246-.697l36.703 36.703c.538.538.041 1.433-.697 1.246C20.6 94.16 5.84 79.4 1.225 61.523ZM.002 46.811a.997.997 0 0 0 .291.749l52.147 52.147a.998.998 0 0 0 .749.291 50.328 50.328 0 0 0 9.235-1.119c.667-.149.904-.972.422-1.454L1.575 37.154c-.482-.482-1.305-.245-1.454.422A50.328 50.328 0 0 0 .002 46.81Zm4.528-18.34a.998.998 0 0 0 .195 1.144l64.66 64.66a.998.998 0 0 0 1.144.195 50.45 50.45 0 0 0 5.913-3.46.999.999 0 0 0 .14-1.518L9.51 22.418a.999.999 0 0 0-1.518.14 50.45 50.45 0 0 0-3.46 5.913Zm10.435-13.075a.999.999 0 0 0 .002 1.41l68.226 68.226a.999.999 0 0 0 1.41.002c19.292-19.477 19.234-50.97-.176-70.378-19.410-19.410-50.901-19.468-70.378-.176-1.061 1.044.916 1.916.916 1.916Z" />
    </svg>
  )
}

function QrSmallIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="3" height="3" />
      <rect x="18" y="14" width="3" height="3" />
      <rect x="14" y="18" width="3" height="3" />
      <rect x="18" y="18" width="3" height="3" />
    </svg>
  )
}

function PlusIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  )
}
