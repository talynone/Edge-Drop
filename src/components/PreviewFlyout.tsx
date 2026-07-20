import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from '../store/appStore'
import { formatBytes } from '../lib/format'
import { getFileKind } from '../lib/fileType'
import { FileKindIcon } from './icons'
import { createPortal } from 'react-dom'

export function PreviewFlyout({ isRight }: { isRight: boolean }) {
  const previewItemId = useStore((s) => s.previewItemId)
  const items = useStore((s) => s.items)
  const previewItemRect = useStore((s) => s.previewItemRect)
  const settings = useStore((s) => s.settings)
  
  const item = previewItemId ? items.find((i) => i.id === previewItemId) : null

  // The vertical center of the clicked item card, expressed as a % of the flyout height.
  // This anchors the transformOrigin so the flyout physically grows FROM and collapses
  // TO the exact item card — identical to macOS window minimize-to-dock.
  const originY = (() => {
    if (!previewItemRect) return '50%'
    const panelHeightPx = (settings.panelHeight || 0.6) * window.innerHeight
    const panelTop = (window.innerHeight - panelHeightPx) / 2
    const itemCenterY = previewItemRect.y + previewItemRect.height / 2
    const relY = itemCenterY - panelTop
    const pct = Math.max(0, Math.min(100, (relY / panelHeightPx) * 100))
    return `${pct}%`
  })()

  const maxFlyoutHeight = `calc(${(settings.panelHeight || 0.6) * 100}vh - 24px)`

  return createPortal(
    <AnimatePresence mode="wait" onExitComplete={() => {
      if (!useStore.getState().previewItemId) {
        window.edge.setPreviewMode(false)
      }
    }}>
      {item && (
        <div style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          [isRight ? 'right' : 'left']: 'var(--panel-width)',
          marginLeft: isRight ? 0 : 12,
          marginRight: isRight ? 12 : 0,
          width: 420,
          display: 'flex',
          alignItems: 'center',
          pointerEvents: 'none',
          zIndex: 5,
        }}>
          <motion.div
            key={item.id}
            initial={{ opacity: 0, scaleX: 0.3, scaleY: 0.15 }}
            animate={{ opacity: 1, scaleX: 1, scaleY: 1 }}
            exit={{ opacity: 0, scaleX: 0.3, scaleY: 0.15 }}
            transition={{ 
              type: 'spring', stiffness: 380, damping: 30, mass: 0.8,
              opacity: { type: 'tween', duration: 0.18, ease: 'easeOut' }
            }}
            style={{
              width: '100%',
              maxHeight: maxFlyoutHeight,
              background: '#000000',
              borderRadius: 16,
              border: '1px solid rgba(255,255,255,0.06)',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
              pointerEvents: 'auto',
              transformOrigin: `${isRight ? '100%' : '0%'} ${originY}`,
            }}
          >
          {/* Content — even bezels, no header chrome */}
          <div style={{ padding: '20px', overflowY: 'auto', flex: 1, minHeight: 0 }}>
            <PreviewContent item={item} />
          </div>
        </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  )
}

function PreviewContent({ item }: { item: any }) {
  if (item.data.kind === 'text') {
    return (
      <div style={{ color: 'rgba(255,255,255,0.9)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, lineHeight: 1.5, fontFamily: 'monospace' }}>
        {item.data.text.length > 20000 
          ? item.data.text.slice(0, 20000) + '\n\n... (Content truncated for preview)' 
          : item.data.text}
      </div>
    )
  }
  
  if (item.data.kind === 'image') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {item.data.imageId && (
          <img src={`edgelocal://${item.data.imageId}`} alt="preview" style={{ width: '100%', maxHeight: '65vh', objectFit: 'contain', borderRadius: 8 }} draggable={false} />
        )}
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
          {item.data.width} &times; {item.data.height} &middot; {formatBytes(item.data.bytes)}
        </div>
      </div>
    )
  }

  if (item.data.kind === 'image-collection') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {item.data.images.map((img: any, idx: number) => (
          <div key={img.imageId} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <img src={`edgelocal://${img.imageId}`} alt="" style={{ width: '100%', borderRadius: 8 }} draggable={false} />
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', textAlign: 'center' }}>
              {idx + 1} of {item.data.images.length} &middot; {img.width} &times; {img.height} &middot; {formatBytes(img.bytes)}
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (item.data.kind === 'files') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {item.data.paths.map((p: string, i: number) => {
          const entry = item.data.entries?.[i]
          const info = getFileKind(p)
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 8, background: 'rgba(255,255,255,0.03)', borderRadius: 8 }}>
              {entry?.isImage && entry.preview ? (
                <img src={entry.preview} alt="" style={{ width: 32, height: 32, borderRadius: 4, objectFit: 'cover' }} />
              ) : (
                <div style={{ color: info.color }}>
                  <FileKindIcon path={p} width={24} height={24} />
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.9)', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                  {entry?.name || p.split(/[\\/]/).pop()}
                </span>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
                  {entry?.size ? formatBytes(entry.size) : info.label}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  return null
}
