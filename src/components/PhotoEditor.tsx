import { useEffect, useId, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Camera, ImagePlus, Trash2 } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/primitives'
import { Avatar } from '@/components/office/OfficeVisuals'
import { usePhotos, useSetPhoto } from '@/hooks/usePhotos'
import {
  MAX_ZOOM,
  clampCrop,
  decodePhoto,
  drawCrop,
  initialCrop,
  photoProblem,
  renderPhoto,
  type Crop,
  type Source,
} from '@/lib/photoImage'
import { TOUCH } from '@/lib/touch'
import { useToastStore } from '@/stores/toastStore'

/**
 * Change a profile photo (0007): pick a picture, move and zoom it inside the
 * circle, save. Used from Your desk (your own) and Settings (your own, and
 * anyone's for Mr Tito). Who may change whose photo is decided by 0007; this
 * only offers the button where it applies.
 */

/** The crop view, on screen. The saved photo is 512 px whatever this is. */
const VIEW_PX = 280

/** The move buttons, for anyone who cannot drag (WCAG 2.5.7). */
const MOVES = [
  { label: 'Move photo left', icon: ArrowLeft, d: [-24, 0] },
  { label: 'Move photo up', icon: ArrowUp, d: [0, -24] },
  { label: 'Move photo down', icon: ArrowDown, d: [0, 24] },
  { label: 'Move photo right', icon: ArrowRight, d: [24, 0] },
] as const

export function PhotoEditor({
  userId,
  name,
  open,
  onOpenChange,
}: {
  userId: string
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const id = useId()
  const fileInput = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drag = useRef<{ x: number; y: number } | null>(null)
  // The decoded picture (a phone photo can hold ~50 MB) and the pick that is
  // allowed to set it, so a slow decode never lands after a newer pick or a
  // close.
  const sourceRef = useRef<Source | null>(null)
  const pickRef = useRef(0)
  const [source, setSource] = useState<Source | null>(null)
  const [crop, setCrop] = useState<Crop | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const { data: photos } = usePhotos()
  const setPhoto = useSetPhoto()
  const showToast = useToastStore((s) => s.showToast)
  const current = photos?.paths[userId]

  const replaceSource = (next: Source | null) => {
    sourceRef.current?.close()
    sourceRef.current = next
    setSource(next)
  }

  // A fresh start every time the dialog closes; the decoded picture is freed.
  useEffect(() => {
    if (open) return
    pickRef.current += 1
    replaceSource(null)
    setCrop(null)
    setProblem(null)
    setConfirmRemove(false)
  }, [open])

  // Settings unmounts the editor instead of closing it: free the picture then too.
  useEffect(
    () => () => {
      pickRef.current += 1
      sourceRef.current?.close()
      sourceRef.current = null
    },
    [],
  )

  /** No closing halfway through a save. */
  const requestOpenChange = (next: boolean) => {
    if (!next && busy) return
    onOpenChange(next)
  }

  // Redraw the preview at the screen's pixel density.
  useEffect(() => {
    if (!source || !crop || !canvasRef.current) return
    drawCrop(canvasRef.current, source, crop, Math.round(VIEW_PX * Math.min(window.devicePixelRatio || 1, 2)))
  }, [source, crop])

  const choose = async (file: File | undefined) => {
    if (!file) return
    const bad = photoProblem(file)
    if (bad) return setProblem(bad)
    setProblem(null)
    setBusy(true)
    const pick = ++pickRef.current
    try {
      const src = await decodePhoto(file)
      if (pick !== pickRef.current) return src.close()
      replaceSource(src)
      setCrop(initialCrop(src.width, src.height))
    } catch (err) {
      if (pick === pickRef.current) setProblem(err instanceof Error ? err.message : 'That picture could not be opened.')
    } finally {
      if (pick === pickRef.current) setBusy(false)
    }
  }

  /** Move the picture under the circle by screen pixels (drag or arrow keys). */
  const pan = (dx: number, dy: number) => {
    if (!source) return
    // From the latest crop: several pointer moves can land in one frame.
    setCrop((c) => {
      if (!c) return c
      const k = Math.min(source.width, source.height) / c.zoom / VIEW_PX
      return clampCrop({ ...c, cx: c.cx - dx * k, cy: c.cy - dy * k }, source.width, source.height)
    })
  }

  const save = async () => {
    if (!source || !crop) return
    setBusy(true)
    setProblem(null)
    try {
      const image = await renderPhoto(source, crop)
      await setPhoto.mutateAsync({ userId, image })
      showToast('Photo saved', 'success')
      setBusy(false)
      onOpenChange(false)
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'The photo was not saved.')
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    setProblem(null)
    try {
      await setPhoto.mutateAsync({ userId, image: null })
      showToast('Photo removed', 'success')
      setBusy(false)
      onOpenChange(false)
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'The photo was not removed.')
      setBusy(false)
    }
  }

  const picking = !source
  return (
    <Modal
      open={open}
      onOpenChange={requestOpenChange}
      title={picking ? 'Profile photo' : 'Position your photo'}
      description={
        picking
          ? `Shown on ${name.split(' ')[0]}'s door, desk and reports, to the team only.`
          : 'Drag it or use the arrows to move it, and the slider to zoom.'
      }
      footer={
        picking ? (
          <Button variant="secondary" className={TOUCH} disabled={busy} onClick={() => requestOpenChange(false)}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="secondary" className={TOUCH} disabled={busy} onClick={() => fileInput.current?.click()}>
              Choose another
            </Button>
            <Button className={TOUCH} loading={busy} onClick={() => void save()}>
              Save photo
            </Button>
          </>
        )
      }
    >
      {/* Out of the tab order: the buttons are the controls. */}
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        tabIndex={-1}
        aria-hidden
        className="sr-only"
        onChange={(e) => {
          void choose(e.target.files?.[0])
          e.target.value = ''
        }}
      />

      {picking ? (
        <div className="flex flex-col items-center gap-4 py-2 text-center">
          <Avatar name={name} userId={userId} size="lg" className="scale-[1.6] my-4" />
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              className={TOUCH}
              loading={busy}
              icon={current ? <Camera size={15} strokeWidth={1.75} /> : <ImagePlus size={15} strokeWidth={1.75} />}
              onClick={() => fileInput.current?.click()}
            >
              {current ? 'Change photo' : 'Choose a photo'}
            </Button>
            {current && !confirmRemove ? (
              <Button
                variant="danger"
                className={TOUCH}
                disabled={busy}
                icon={<Trash2 size={15} strokeWidth={1.75} />}
                onClick={() => setConfirmRemove(true)}
              >
                Remove
              </Button>
            ) : null}
          </div>
          {current && confirmRemove ? (
            <div role="group" aria-labelledby={`${id}-confirm`} className="flex flex-col items-center gap-2">
              <p id={`${id}-confirm`} className="text-[13px] text-text-primary">
                Remove this photo? The initial shows instead.
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="secondary" className={TOUCH} disabled={busy} onClick={() => setConfirmRemove(false)}>
                  Keep it
                </Button>
                <Button variant="danger" className={TOUCH} loading={busy} onClick={() => void remove()}>
                  Yes, remove
                </Button>
              </div>
            </div>
          ) : null}
          <p className="text-[12px] text-text-muted">Any photo; it is cropped square and made small before it is saved.</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4">
          <div
            role="group"
            aria-label="Photo crop. Drag, use the arrow keys or the move buttons to move it."
            tabIndex={0}
            className="relative touch-none overflow-hidden rounded-[14px] bg-ink outline-none focus-visible:ring-2 focus-visible:ring-brand"
            style={{ width: VIEW_PX, height: VIEW_PX, maxWidth: '72vw', maxHeight: '72vw' }}
            onPointerDown={(e) => {
              drag.current = { x: e.clientX, y: e.clientY }
              e.currentTarget.setPointerCapture(e.pointerId)
            }}
            onPointerMove={(e) => {
              if (!drag.current) return
              const scale = VIEW_PX / e.currentTarget.getBoundingClientRect().width
              pan((e.clientX - drag.current.x) * scale, (e.clientY - drag.current.y) * scale)
              drag.current = { x: e.clientX, y: e.clientY }
            }}
            onPointerUp={() => (drag.current = null)}
            onPointerCancel={() => (drag.current = null)}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 24 : 6
              // Each key moves the picture the way it points, as a drag does.
              const move: Record<string, [number, number]> = {
                ArrowLeft: [-step, 0],
                ArrowRight: [step, 0],
                ArrowUp: [0, -step],
                ArrowDown: [0, step],
              }
              const m = move[e.key]
              if (!m) return
              e.preventDefault()
              pan(m[0], m[1])
            }}
          >
            <canvas ref={canvasRef} className="size-full cursor-grab active:cursor-grabbing" />
            {/* The circle the photo will be shown in; outside it is dimmed. */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-full"
              style={{ boxShadow: '0 0 0 999px rgba(11, 26, 18, 0.55)', outline: '2px solid rgba(246, 250, 247, 0.85)' }}
            />
          </div>
          <div className="flex w-full max-w-[280px] items-center gap-3">
            <label htmlFor={`${id}-zoom`} className="text-[12px] font-medium text-text-secondary">
              Zoom
            </label>
            <input
              id={`${id}-zoom`}
              type="range"
              min={1}
              max={MAX_ZOOM}
              step={0.01}
              value={crop?.zoom ?? 1}
              aria-valuetext={`${Math.round((crop?.zoom ?? 1) * 100)}%`}
              onChange={(e) => {
                const zoom = Number(e.target.value)
                if (source) setCrop((c) => c && clampCrop({ ...c, zoom }, source.width, source.height))
              }}
              className="h-11 flex-1 accent-forest"
            />
          </div>
          <div className="flex gap-2">
            {MOVES.map(({ label, icon: Icon, d }) => (
              <button
                key={label}
                type="button"
                aria-label={label}
                onClick={() => pan(d[0], d[1])}
                className="grid size-11 place-items-center rounded-full border border-line text-text-secondary transition-colors hover:bg-surface-sunken hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <Icon size={16} strokeWidth={1.75} aria-hidden />
              </button>
            ))}
          </div>
        </div>
      )}

      {problem ? (
        <p role="alert" className="mt-3 text-center text-[13px] text-state-danger">
          {problem}
        </p>
      ) : null}
    </Modal>
  )
}
