import {
  Code,
  CreditCard,
  FlaskConical,
  Folder,
  Headphones,
  Megaphone,
  Palette,
  Package,
  TrendingUp,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import { divisionKind, type DivisionKind } from '../../../../shared/company-identity'
import { cn } from '@/lib/utils'

type Look = { icon: LucideIcon; tile: string; glyph: string }

// Why: the same tints the console gives its departments, so a domain reads the same in both apps.
const LOOK: Record<DivisionKind, Look> = {
  sales: {
    icon: TrendingUp,
    tile: 'bg-indigo-500/15',
    glyph: 'text-indigo-600 dark:text-indigo-400'
  },
  operations: { icon: Wrench, tile: 'bg-teal-500/15', glyph: 'text-teal-600 dark:text-teal-400' },
  development: {
    icon: Code,
    tile: 'bg-violet-500/15',
    glyph: 'text-violet-600 dark:text-violet-400'
  },
  creative: { icon: Palette, tile: 'bg-pink-500/15', glyph: 'text-pink-600 dark:text-pink-400' },
  prototypes: {
    icon: FlaskConical,
    tile: 'bg-amber-500/15',
    glyph: 'text-amber-600 dark:text-amber-400'
  },
  'customer-service': {
    icon: Headphones,
    tile: 'bg-cyan-500/15',
    glyph: 'text-cyan-600 dark:text-cyan-400'
  },
  finance: { icon: CreditCard, tile: 'bg-lime-500/15', glyph: 'text-lime-600 dark:text-lime-400' },
  marketing: {
    icon: Megaphone,
    tile: 'bg-orange-500/15',
    glyph: 'text-orange-600 dark:text-orange-400'
  },
  product: { icon: Package, tile: 'bg-sky-500/15', glyph: 'text-sky-600 dark:text-sky-400' },
  generic: { icon: Folder, tile: 'bg-muted', glyph: 'text-muted-foreground' }
}

/** A department's tinted tile and glyph; unknown names get the neutral folder. */
export function DivisionMark({
  name,
  className
}: {
  name: string
  className?: string
}): React.JSX.Element {
  const kind = divisionKind(name)
  const look = LOOK[kind]
  const Icon = look.icon
  return (
    <span
      aria-hidden
      data-division-kind={kind}
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-md',
        look.tile,
        className
      )}
    >
      <Icon className={cn('size-3', look.glyph)} />
    </span>
  )
}
