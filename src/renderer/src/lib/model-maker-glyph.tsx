import { MODEL_MAKER_GLYPHS, type ModelMakerGlyphId } from './model-maker-glyphs'

/** A model maker's mark in the current text colour, sized like every other provider icon. */
export function ModelMakerGlyph({
  id,
  size = 14
}: {
  id: ModelMakerGlyphId
  size?: number
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      fill="currentColor"
      fillRule="evenodd"
      className="shrink-0"
    >
      {MODEL_MAKER_GLYPHS[id].map((path) => (
        <path key={path.slice(0, 24)} d={path} />
      ))}
    </svg>
  )
}
