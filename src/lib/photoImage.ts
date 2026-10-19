/**
 * Turning a chosen picture into a profile photo (0007): decode it the right
 * way up, crop the square the person picked, resize to 512 px and compress.
 * Everything happens in the browser, so what is uploaded is ~30-80 KB, never
 * the 4 MB original from a phone camera.
 */

/** Side of the stored photo. Twice the largest place it is shown (48 px). */
export const PHOTO_PX = 512
/** The bucket's limit (0007). A 512 px WebP is far below it. */
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024
/** What we agree to decode. Large enough for any phone camera. */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024

export function photoProblem(file: File): string | null {
  if (!file.type.startsWith('image/')) return 'Choose an image: a JPEG, PNG, WebP or HEIC photo.'
  if (file.size > MAX_SOURCE_BYTES) return 'That picture is over 25 MB. Choose a smaller one.'
  return null
}

export interface Source {
  image: CanvasImageSource
  width: number
  height: number
  close: () => void
}

/** Decode with the camera's rotation applied, so a portrait stays upright. */
export async function decodePhoto(file: File): Promise<Source> {
  if ('createImageBitmap' in window) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return { image: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() }
    } catch {
      // Fall through: some browsers decode more formats through <img>.
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await img.decode()
    return { image: img, width: img.naturalWidth, height: img.naturalHeight, close: () => undefined }
  } catch {
    throw new Error('That picture could not be opened here. Try a JPEG or PNG.')
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** The part of the source kept: a square `side` px wide centred on (cx, cy). */
export interface Crop {
  cx: number
  cy: number
  zoom: number
}

export const MAX_ZOOM = 4

/** The whole short side, centred. */
export function initialCrop(width: number, height: number): Crop {
  return { cx: width / 2, cy: height / 2, zoom: 1 }
}

/** Keeps the square inside the picture whatever the zoom or drag. */
export function clampCrop(c: Crop, width: number, height: number): Crop {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, c.zoom))
  const half = Math.min(width, height) / zoom / 2
  return {
    zoom,
    cx: Math.min(width - half, Math.max(half, c.cx)),
    cy: Math.min(height - half, Math.max(half, c.cy)),
  }
}

export function cropSquare(c: Crop, width: number, height: number): { sx: number; sy: number; side: number } {
  const side = Math.min(width, height) / c.zoom
  return { sx: c.cx - side / 2, sy: c.cy - side / 2, side }
}

export function drawCrop(canvas: HTMLCanvasElement, src: Source, c: Crop, px: number) {
  canvas.width = px
  canvas.height = px
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  // White behind a see-through PNG, which JPEG would otherwise turn black.
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, px, px)
  const { sx, sy, side } = cropSquare(c, src.width, src.height)
  ctx.drawImage(src.image, sx, sy, side, side, 0, 0, px, px)
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))

/**
 * The final file. WebP where the browser can encode it (it says so by
 * returning that type), JPEG otherwise; quality steps down until it is under
 * the bucket's limit, which at 512 px it always is on the first try.
 */
export async function renderPhoto(src: Source, c: Crop): Promise<Blob> {
  const canvas = document.createElement('canvas')
  drawCrop(canvas, src, c, PHOTO_PX)
  for (const quality of [0.86, 0.75, 0.6, 0.45]) {
    let blob = await toBlob(canvas, 'image/webp', quality)
    if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', quality)
    if (blob && blob.size <= MAX_PHOTO_BYTES) return blob
  }
  throw new Error('That photo could not be made small enough. Try another picture.')
}
