/**
 * useEdgeHover — the heart of the "invisible until you approach the edge" feel.
 *
 * Detection strategy:
 *
 *  OPENING: cursor dwells in the leftmost TRIGGER_PX band within the hot zone.
 *
 *  CLOSING — two complementary mechanisms:
 *
 *  1. panel:leave custom event (primary): Panel.tsx dispatches this event on the
 *     blade div's onMouseLeave. React's mouseleave does NOT bubble through child
 *     elements, so it fires exactly when the cursor leaves the visible black area.
 *     This correctly handles all directions (right, top, bottom) without relying
 *     on Electron's broken document-level pointerleave for transparent windows.
 *
 *  2. Y-axis overshooting (backup): while the cursor is inside the window, we
 *     track whether it has gone above or below the panel's visual bounds via
 *     pointermove. This catches cases where the cursor leaves the panel vertically
 *     before React's mouseleave has a chance to fire.
 *
 *  Drag-awareness: while an external OS file drag is active we never close.
 */
import { useEffect, useRef } from 'react'
import { edge } from '../lib/edge'
import { useStore } from '../store/appStore'

const TRIGGER_PX = 3    // leftmost px that count as "the edge"
const DWELL_MS = 120     // cursor must linger this long to open
const GRACE_MS = 250     // close delay after leaving
const PANEL_WIDE = 270   // blade is 270px (var(--panel-width))
/** Hysteresis thresholds for closing the panel.
 * KEEP_OPEN_PX: if cursor x is <= this, the panel stays open (clearly inside blade).
 * START_CLOSE_PX: if cursor x is > this, start the close timer (clearly outside).
 * Gap between the two prevents rapid cancel/schedule oscillation at the blade edge
 * when the cursor hovers just outside the visual boundary.
 */
const KEEP_OPEN_PX = PANEL_WIDE - 15  // 255 — clearly inside blade
const START_CLOSE_PX = PANEL_WIDE + 20 // 290 — 20px buffer outside the visual boundary
const BUFFER_PX = 30                 // 30px overshoot buffer across adjacent monitors
const PREVIEW_WIDE = 740             // Extended width when preview flyout is active

export const PANEL_LEAVE_EVENT = 'panel:leave'
export const PANEL_ENTER_EVENT = 'panel:enter'

// How long to keep the panel alive after the user explicitly closes the preview
// via the X button. This prevents the jarring simultaneous collapse of both
// the preview and the clipboard.
const PREVIEW_CLOSE_STAY_MS = 2500

// Module-level flag set by the X button click. useEdgeHover reads this to
// extend the close grace period without needing React state or store updates.
let _previewClosedByUser = false
let _previewClosedTimer: number | undefined

/**
 * Call this from the preview flyout's X button to signal that the user
 * deliberately closed the preview — the clipboard should stay open for a
 * while so they can keep browsing.
 */
export function notifyPreviewClosedByUser(): void {
  _previewClosedByUser = true
  if (_previewClosedTimer !== undefined) window.clearTimeout(_previewClosedTimer)
  _previewClosedTimer = window.setTimeout(() => {
    _previewClosedByUser = false
    _previewClosedTimer = undefined
  }, PREVIEW_CLOSE_STAY_MS)
}

export function useEdgeHover(): void {
  const open = useStore((s) => s.open)
  const setOpen = useStore((s) => s.setOpen)
  const settings = useStore((s) => s.settings)
  const dragActive = useStore((s) => s.dragActive)
  const setDragActive = useStore((s) => s.setDragActive)
  const internalDragReq = useStore((s) => s.internalDragReq)
  const previewItemId = useStore((s) => s.previewItemId)

  // All reactive values accessed inside events kept in refs so the
  // event-listener effect never needs to restart (restarting cancels timers).
  const openRef = useRef(open)
  openRef.current = open

  const dragActiveRef = useRef(dragActive)
  dragActiveRef.current = dragActive

  const internalDragRef = useRef(!!internalDragReq)
  internalDragRef.current = !!internalDragReq

  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const previewRef = useRef(previewItemId)
  previewRef.current = previewItemId

  // Access setPreviewItemId without subscribing (avoids restarting the stable effect).
  const setPreviewItemId = useStore.getState().setPreviewItemId

  // Throttle the self-healing setInteractive(true) call.
  // Without this, it fires at 60Hz (every 16ms) via the cursor-edge poll,
  // flooding the IPC queue and starving the messages that open the panel.
  const lastSetInteractiveRef = useRef(0)

  // Hot zone and panel bounds, recomputed on resize to avoid reading DOM at 1000Hz
  const zone = useRef({ top: 0, bottom: 0, midY: 0, panelHalfH: 0 })

  // Last known pointer position (updated on every pointermove). Used to vet
  // `panel:leave` events — Framer Motion layout reflows can fire spurious
  // mouseleave events while the cursor never actually left the blade.
  const lastClient = useRef({ x: -1, y: -1 })

  useEffect(() => {
    const recompute = () => {
      const h = window.innerHeight
      const s = settingsRef.current
      const half = h * s.hotZoneHeight / 2
      const panelHalfH = h * (s.panelHeight || 0.5) / 2
      zone.current = { 
        top: h / 2 - half, 
        bottom: h / 2 + half,
        midY: h / 2,
        panelHalfH
      }
    }
    recompute()
    window.addEventListener('resize', recompute)
    return () => window.removeEventListener('resize', recompute)
  }, [settings.hotZoneHeight, settings.panelHeight])

  // Single stable effect — deps never change after mount.
  useEffect(() => {
    let dwellTimer: number | undefined
    let graceTimer: number | undefined
    let interactiveTimer: number | undefined

    const closePanel = () => {
      if (!openRef.current) return
      if (dragActiveRef.current && !internalDragRef.current) return

      // If preview is open, dismiss it first and wait for its exit
      // animation to finish (~350ms) before collapsing the panel.
      // This prevents both animations from fighting each other.
      if (previewRef.current) {
        setPreviewItemId(null)
        window.setTimeout(() => {
          setOpen(false)
          if (interactiveTimer !== undefined) window.clearTimeout(interactiveTimer)
          interactiveTimer = window.setTimeout(() => {
            interactiveTimer = undefined
            if (!openRef.current) edge.setInteractive(false)
          }, 180)
        }, 350)
        return
      }

      setOpen(false)
      if (interactiveTimer !== undefined) window.clearTimeout(interactiveTimer)
      interactiveTimer = window.setTimeout(() => {
        interactiveTimer = undefined
        if (!openRef.current) {
          edge.setInteractive(false)
        }
      }, 180)
    }

    const scheduleClose = (delay = GRACE_MS) => {
      if (dragActiveRef.current && !internalDragRef.current) return
      if (graceTimer !== undefined) return // already closing
      // If the user just closed the preview via X, give them extra time before
      // the clipboard collapses so they can keep using it.
      const effectiveDelay = _previewClosedByUser ? PREVIEW_CLOSE_STAY_MS : delay
      graceTimer = window.setTimeout(closePanel, effectiveDelay)
    }

    const cancelClose = () => {
      if (graceTimer !== undefined) {
        window.clearTimeout(graceTimer)
        graceTimer = undefined
      }
      if (interactiveTimer !== undefined) {
        window.clearTimeout(interactiveTimer)
        interactiveTimer = undefined
      }
      // User re-entered the clipboard — clear the grace period flag so the
      // next time they leave, the panel retracts at normal speed instead of
      // waiting the full 2.5s safety net.
      if (_previewClosedByUser) {
        _previewClosedByUser = false
        if (_previewClosedTimer !== undefined) {
          window.clearTimeout(_previewClosedTimer)
          _previewClosedTimer = undefined
        }
      }
    }

    const openPanel = () => {
      cancelClose()
      if (dwellTimer !== undefined) {
        window.clearTimeout(dwellTimer)
        dwellTimer = undefined
      }
      if (interactiveTimer !== undefined) {
        window.clearTimeout(interactiveTimer)
        interactiveTimer = undefined
      }
      edge.setInteractive(true)
      if (openRef.current) return
      setOpen(true)
    }

    // ── panel:leave / panel:enter (from Panel.tsx blade div) ──────────────
    // NOTE: `mouseleave` can fire spuriously when Framer Motion's `layout`
    // reflow repositions an exiting child out from under the cursor (e.g. on
    // expand). So we treat `panel:leave` as a *hint* and only actually close
    // if the last known pointer position is genuinely outside the blade.
    const isInsideBlade = () => {
      const { x, y } = lastClient.current
      if (x < -BUFFER_PX || y < 0) return true // unknown — be conservative, don't close
      const s = settingsRef.current
      const currentPanelWide = previewRef.current ? PREVIEW_WIDE : PANEL_WIDE

      if (s.stickPosition === 'right') {
        return x >= window.innerWidth - currentPanelWide - BUFFER_PX && x <= window.innerWidth + BUFFER_PX
      }
      // left
      return x >= -BUFFER_PX && x <= currentPanelWide + BUFFER_PX
    }

    const onPanelLeave = () => {
      if (isInsideBlade()) {
        cancelClose()
        return
      }
      scheduleClose()
    }

    const onPanelEnter = () => {
      cancelClose()
    }

    // ── main-process cursor poll (replaces broken pointermove forwarding) ──
    // The main process polls screen.getCursorScreenPoint() every 16ms and
    // sends window:cursor-edge with raw x/y coords. We check the hot zone
    // here with the renderer's own settings so everything stays in sync.
    const unsubCursorEdge = window.edge.onCursorEdge((data) => {
      lastClient.current = { x: data.x, y: data.y }
      const { stickPosition, displayWidth } = data
      const { top, bottom, midY, panelHalfH } = zone.current

      const currentKeepOpenPx = previewRef.current ? PREVIEW_WIDE - 15 : KEEP_OPEN_PX
      const currentStartClosePx = previewRef.current ? PREVIEW_WIDE + 20 : START_CLOSE_PX

      switch (stickPosition) {
        case 'right': {
          const distFromRight = displayWidth - data.x
          const inEdge = distFromRight >= -BUFFER_PX && distFromRight <= TRIGGER_PX
          const inZone = data.y >= top && data.y <= bottom

          if (inEdge && inZone && !openRef.current) {
            cancelClose()
            if (dwellTimer === undefined) {
              dwellTimer = window.setTimeout(() => {
                dwellTimer = undefined
                openPanel()
              }, DWELL_MS)
            }
            return
          }

          if (dwellTimer !== undefined) {
            window.clearTimeout(dwellTimer)
            dwellTimer = undefined
          }

          if (!openRef.current) return

          const now = Date.now()
          if (now - lastSetInteractiveRef.current > 2000) {
            lastSetInteractiveRef.current = now
            edge.setInteractive(true)
          }

          const insideY = data.y >= midY - panelHalfH && data.y <= midY + panelHalfH

          if (distFromRight >= -BUFFER_PX && distFromRight <= currentKeepOpenPx && insideY) {
            cancelClose()
            return
          }

          if (distFromRight > currentStartClosePx || distFromRight < -BUFFER_PX || !insideY) {
            scheduleClose()
          }
          break
        }



        // left
        default: {
          const inEdge = data.x >= -BUFFER_PX && data.x <= TRIGGER_PX
          const inZone = data.y >= top && data.y <= bottom

          if (inEdge && inZone && !openRef.current) {
            cancelClose()
            if (dwellTimer === undefined) {
              dwellTimer = window.setTimeout(() => {
                dwellTimer = undefined
                openPanel()
              }, DWELL_MS)
            }
            return
          }

          if (dwellTimer !== undefined) {
            window.clearTimeout(dwellTimer)
            dwellTimer = undefined
          }

          if (!openRef.current) return

          const now = Date.now()
          if (now - lastSetInteractiveRef.current > 2000) {
            lastSetInteractiveRef.current = now
            edge.setInteractive(true)
          }

          const insideY = data.y >= midY - panelHalfH && data.y <= midY + panelHalfH

          if (data.x >= -BUFFER_PX && data.x <= currentKeepOpenPx && insideY) {
            cancelClose()
            return
          }

          if (data.x > currentStartClosePx || data.x < -BUFFER_PX || !insideY) {
            scheduleClose()
          }
          break
        }
      }
    })

    // ── keyboard ───────────────────────────────────────────────────────────
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && openRef.current) scheduleClose(0)
    }

    // ── OS file drag awareness ─────────────────────────────────────────────
    const onDocDragEnter = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault()
        setDragActive(true)
        openPanel()
      }
    }
    const onDocDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault()
        cancelClose()
      }
    }
    const onDocDragLeave = (e: DragEvent) => {
      if (!e.relatedTarget) {
        setDragActive(false)
        if (internalDragRef.current) scheduleClose(0)
      }
    }
    const onDocDrop = (e: DragEvent) => {
      e.preventDefault()
      setDragActive(false)
    }
    const onDocDragEnd = (e: DragEvent) => {
      e.preventDefault()
      setDragActive(false)
    }

    // ── register ───────────────────────────────────────────────────────────
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener(PANEL_LEAVE_EVENT, onPanelLeave)
    window.addEventListener(PANEL_ENTER_EVENT, onPanelEnter)
    document.addEventListener('dragenter', onDocDragEnter)
    document.addEventListener('dragover', onDocDragOver)
    document.addEventListener('dragleave', onDocDragLeave)
    document.addEventListener('drop', onDocDrop)
    document.addEventListener('dragend', onDocDragEnd)

    return () => {
      unsubCursorEdge()
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener(PANEL_LEAVE_EVENT, onPanelLeave)
      window.removeEventListener(PANEL_ENTER_EVENT, onPanelEnter)
      document.removeEventListener('dragenter', onDocDragEnter)
      document.removeEventListener('dragover', onDocDragOver)
      document.removeEventListener('dragleave', onDocDragLeave)
      document.removeEventListener('drop', onDocDrop)
      document.removeEventListener('dragend', onDocDragEnd)
      window.clearTimeout(dwellTimer)
      window.clearTimeout(graceTimer)
      window.clearTimeout(interactiveTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setOpen, setDragActive])
}
