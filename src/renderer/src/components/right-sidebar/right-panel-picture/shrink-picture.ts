/** Longest edge kept; sharp on a wide right panel, small enough to keep on this device. */
const MAX_EDGE = 2400
/** Local storage allows about 5 MB per app; a picture stays well under it. */
const MAX_DATA_URL_LENGTH = 3_500_000

async function encode(bitmap: ImageBitmap, maxEdge: number, quality: number): Promise<string> {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('This picture could not be read.')
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', quality)
}

/** Reads an image file into a JPEG data URL small enough to keep as the right panel picture. */
export async function shrinkPictureToDataUrl(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file)
  try {
    for (const [edge, quality] of [
      [MAX_EDGE, 0.86],
      [1800, 0.8],
      [1200, 0.75]
    ] as const) {
      const dataUrl = await encode(bitmap, edge, quality)
      if (dataUrl.length <= MAX_DATA_URL_LENGTH) {
        return dataUrl
      }
    }
    throw new Error('This picture is too large to keep. Try a smaller one.')
  } finally {
    bitmap.close()
  }
}
