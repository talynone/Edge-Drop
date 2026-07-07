/**
 * IPC handler registration.
 *
 * Each `ipcMain.handle` here mirrors a contract in `shared/ipc.ts`. The
 * renderer calls them through the typed preload bridge, so a signature mismatch
 * is a compile-time error rather than a runtime one.
 */
import { app, ipcMain, clipboard, nativeImage } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { type InvokeMap, type InvokeChannel, type SendMap, type SendChannel } from '../../shared/ipc'
import { getStore, loadSettings, saveSettings, pushState, addFiles, getWatcher } from './state'
import { getMainWindow } from './window'
import { setInteractive } from './window'
import { startDragOut, resolveDragData } from './drag'
import { buildFileListBuffer, CF_FILE_LIST } from '../clipboard/formats'
import type { ItemData, MergeResult } from '../../shared/types'

/** Fire a transient toast to the renderer (best-effort; renderer may be closed). */
function toast(message: string, tone: 'info' | 'error' = 'info'): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('ui:toast', { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, message, tone })
  }
}

/** Simulate pressing Ctrl+V via PowerShell after returning focus to the previous active window. */
function simulatePaste(): void {
  execFile('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"
  ], (err) => {
    if (err) console.error('[Main] simulatePaste error:', err)
  })
}

/**
 * Write file *references* onto the Windows clipboard (not path strings).
 *
 * `FileNameW` is the format Explorer/Word/every Windows app reads for a
 * "copy these files" gesture — without it, paste produces literal path text.
 * We also write plain text as a fallback so pure-text targets still get something.
 */
function writeFileListToClipboard(paths: string[]): void {
  clipboard.clear()
  try {
    clipboard.writeBuffer(CF_FILE_LIST, buildFileListBuffer(paths))
  } catch {
    /* writeBuffer can throw for unregistered formats on some platforms; the
       text fallback below still lets text-only targets work. */
  }
  clipboard.writeText(paths.join('\r\n'))
}

/**
 * Type-checked registration helper: guarantees the handler's return matches the
 * contract declared in InvokeMap.
 */
function handle<C extends InvokeChannel>(
  channel: C,
  fn: (...args: InvokeMap[C]['args']) => Promise<InvokeMap[C]['result']> | InvokeMap[C]['result']
): void {
  ipcMain.handle(channel, (_e, ...args) => fn(...(args as InvokeMap[C]['args'])))
}

export function registerIpc(): void {
  handle('state:load', () => {
    return {
      items: getStore().toDto(),
      settings: loadSettings()
    }
  })

  handle('item:set-pinned', (id, pinned) => {
    getStore().setPinned(id, pinned)
    pushState.items()
    return getStore().toDto()
  })

  handle('item:delete', (id) => {
    getStore().delete(id)
    pushState.items()
    return getStore().toDto()
  })

  handle('item:clear', () => {
    getStore().clearUnpinned()
    pushState.items()
    return getStore().toDto()
  })

  handle('item:copy', (id) => {
    const item = getStore().get(id)
    console.log('[IPC] item:copy id=', id, 'found=', !!item)
    if (!item) return false

    const watcher = getWatcher()
    watcher.setPaused(true)
    writeItemToClipboard(item.data)
    console.log('[IPC] item:copy wrote to clipboard, kind=', item.data.kind)

    // Promote the copied item to the top of the history stack
    getStore().add(item.data, loadSettings().historyLimit)
    pushState.items()

    // Unpause after a short delay to allow OS clipboard event to settle.
    // Respect the current incognito state when unpausing.
    setTimeout(() => {
      watcher.setPaused(loadSettings().incognito)
    }, 200)

    return true
  })

  handle('item:copy-subitem', (req) => {
    // Resolve a single sub-item (one file of a bundle, or one image of a
    // collection) and write just that onto the clipboard — not the whole item.
    const dto = getStore().toDto().find((d) => d.id === req.id)
    if (!dto) return false

    let wrote = false
    if (dto.data.kind === 'files' && req.paths && req.paths.length > 0) {
      // Write real file references so pasting into Explorer copies the file,
      // not a path string.
      writeFileListToClipboard(req.paths)
      wrote = true
    } else if (dto.data.kind === 'image-collection' && req.imageId) {
      const img = dto.data.images.find((i) => i.imageId === req.imageId)
      if (img) {
        const src = getStore().getImagePath(img.imageId, img.ext)
        if (src && existsSync(src)) {
          writeFileListToClipboard([src])
          wrote = true
        }
        if (img.preview) {
          const native = nativeImage.createFromDataURL(img.preview)
          if (!native.isEmpty()) {
            if (!wrote) clipboard.clear()
            try { clipboard.writeImage(native); wrote = true } catch {}
          }
        }
      }
    }

    if (!wrote) return false

    // Promote the parent item to the top of the history stack
    const parentItem = getStore().get(req.id)
    if (parentItem) {
      getStore().add(parentItem.data, loadSettings().historyLimit)
      pushState.items()
    }

    const watcher = getWatcher()
    watcher.setPaused(true)
    setTimeout(() => {
      watcher.setPaused(loadSettings().incognito)
    }, 200)

    return true
  })

  handle('item:paste', (id) => {
    const item = getStore().get(id)
    console.log('[IPC] item:paste id=', id, 'found=', !!item)
    if (!item) return false

    const watcher = getWatcher()
    watcher.setPaused(true)

    try {
      writeItemToClipboard(item.data)
      console.log('[IPC] item:paste wrote to clipboard, kind=', item.data.kind)

      // Promote the pasted item to the top of the history stack
      getStore().add(item.data, loadSettings().historyLimit)
      pushState.items()

      // Close panel via toggle so focus returns to the user's active input/text box
      pushState.togglePanel()

      // Wait 200ms for OS focus to settle, then simulate Ctrl+V
      setTimeout(() => {
        simulatePaste()
      }, 200)
    } finally {
      setTimeout(() => {
        watcher.setPaused(loadSettings().incognito)
      }, 350)
    }

    return true
  })

  handle('item:paste-subitem', (req) => {
    const dto = getStore().toDto().find((d) => d.id === req.id)
    if (!dto) return false

    const watcher = getWatcher()
    watcher.setPaused(true)

    try {
      let wrote = false
      if (dto.data.kind === 'files' && req.paths && req.paths.length > 0) {
        writeFileListToClipboard(req.paths)
        wrote = true
      } else if (dto.data.kind === 'image-collection' && req.imageId) {
        const img = dto.data.images.find((i) => i.imageId === req.imageId)
        if (img) {
          const src = getStore().getImagePath(img.imageId, img.ext)
          if (src && existsSync(src)) {
            writeFileListToClipboard([src])
            wrote = true
          }
          if (img.preview) {
            const native = nativeImage.createFromDataURL(img.preview)
            if (!native.isEmpty()) {
              if (!wrote) clipboard.clear()
              try { clipboard.writeImage(native); wrote = true } catch {}
            }
          }
        }
      }

      if (!wrote) return false

      // Promote the parent item to the top of the history stack
      const parentItem = getStore().get(req.id)
      if (parentItem) {
        getStore().add(parentItem.data, loadSettings().historyLimit)
        pushState.items()
      }

      pushState.togglePanel()

      setTimeout(() => {
        simulatePaste()
      }, 200)
    } finally {
      setTimeout(() => {
        watcher.setPaused(loadSettings().incognito)
      }, 350)
    }

    return true
  })

  handle('item:add-files', (paths) => {
    const result = addFiles(paths)
    // If a large drop was split into several stacks, let the user know why
    // they suddenly see multiple items instead of one bundle.
    if (result.stacksCreated > 1) {
      toast(`Split into ${result.stacksCreated} stacks (max 10 each)`, 'info')
    }
    return getStore().toDto()
  })

  handle('item:remove-subitem', (req) => {
    const success = getStore().removeSubitem(req)
    if (success) pushState.items()
    return success
  })

  handle('item:merge', (sourceId, targetId) => {
    const result: MergeResult = getStore().merge(sourceId, targetId)
    if (result.ok) {
      pushState.items()
    } else if (result.reason === 'full') {
      toast(result.message || 'Collection is full (10 max)', 'info')
    } else if (result.reason === 'incompatible') {
      toast(result.message || 'Cannot combine different item types', 'info')
    }
    // 'notfound' fails silently
    return result
  })

  handle('item:split', (req) => {
    console.log('[IPC] item:split called with req=', JSON.stringify(req))
    const success = getStore().split(req)
    console.log('[IPC] item:split success=', success)
    if (success) pushState.items()
    return success
  })

  handle('settings:update', (patch) => {
    const next = saveSettings(patch)
    if (patch.launchAtLogin !== undefined && app.isPackaged) {
      try {
        app.setLoginItemSettings({
          openAtLogin: next.launchAtLogin,
          path: app.getPath('exe')
        })
      } catch { /* ignore */ }
    }
    pushState.settings(next)
    return next
  })

  handle('window:set-interactive', (value) => {
    setInteractive(value)
  })
}

/**
 * Register fire-and-forget (send) listeners.
 *
 * These use `ipcMain.on` + `event.sender` instead of `ipcMain.handle` because
 * the drag-out gesture must be synchronous — `event.sender.startDrag(...)` only
 * works correctly when called from the same event-loop turn as the renderer's
 * `dragstart` event.
 */
function on<C extends SendChannel>(
  channel: C,
  fn: (sender: Electron.WebContents, ...args: SendMap[C]['args']) => void
): void {
  ipcMain.on(channel, (event, ...args) => fn(event.sender, ...(args as SendMap[C]['args'])))
}

export function registerSendListeners(): void {
  on('item:start-drag', (sender, req) => {
    console.log('[IPC] item:start-drag req=', JSON.stringify(req))
    const data = resolveDragData(req)
    if (!data) {
      console.log('[IPC] start-drag: no data resolved')
      return
    }
    console.log('[IPC] start-drag: kind=', data.kind)
    startDragOut(sender, data)
    console.log('[IPC] start-drag returned, sending drag-end')
    sender.send('item:drag-end')

    // Workaround for Electron/Windows not firing drop events on the source window:
    // Check if the user dropped the item back onto our window!
    const { screen, BrowserWindow } = require('electron')
    const point = screen.getCursorScreenPoint()
    const win = BrowserWindow.fromWebContents(sender)
    if (win) {
      const bounds = win.getBounds()
      const isInside = point.x >= bounds.x && point.x <= bounds.x + bounds.width &&
                       point.y >= bounds.y && point.y <= bounds.y + bounds.height
      if (isInside) {
        console.log(`[IPC] Drag ended inside window! Triggering internal-drop at x=${point.x - bounds.x}, y=${point.y - bounds.y}`)
        sender.send('item:internal-drop', { x: point.x - bounds.x, y: point.y - bounds.y })
      }
    }
  })
}

/** Write any item payload back onto the system clipboard. */
export function writeItemToClipboard(data: ItemData): void {
  switch (data.kind) {
    case 'text':
      clipboard.clear()
      clipboard.write({ text: data.text, html: data.html })
      break
    case 'image': {
      const dto = getStore().toDto().find(
        (d) => d.data.kind === 'image' && d.data.imageId === data.imageId
      )
      if (dto && dto.data.kind === 'image') {
        const src = getStore().getImagePath(dto.data.imageId, dto.data.ext)
        let wrote = false
        if (src && existsSync(src)) {
          writeFileListToClipboard([src])
          wrote = true
        }
        const img = nativeImage.createFromDataURL(dto.data.preview)
        if (!img.isEmpty()) {
          if (!wrote) clipboard.clear()
          try { clipboard.writeImage(img) } catch {}
        }
      }
      break
    }
    case 'image-collection': {
      // Copy all image file references of the collection onto the clipboard
      // so pasting into Explorer / Word / Slack copies all images in the group.
      const dto = getStore().toDto().find(
        (d) => d.data.kind === 'image-collection' && d.data.images[0]
      )
      if (dto && dto.data.kind === 'image-collection') {
        const paths: string[] = []
        for (const img of dto.data.images) {
          const src = getStore().getImagePath(img.imageId, img.ext)
          if (existsSync(src)) paths.push(src)
        }
        if (paths.length > 0) {
          writeFileListToClipboard(paths)
        }
        // Also attempt to write the primary image bitmap if possible for image-only paste targets
        const first = dto.data.images[0]
        const img = nativeImage.createFromDataURL(first.preview)
        if (!img.isEmpty()) {
          try {
            clipboard.writeImage(img)
          } catch {
            /* ignore if format conflicts with file list on some systems */
          }
        }
      }
      break
    }
    case 'files':
      // Write real file references so pasting into Explorer copies the file,
      // not a path string.
      writeFileListToClipboard(data.paths)
      break
  }
}
