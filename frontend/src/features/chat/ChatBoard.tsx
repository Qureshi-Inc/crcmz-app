// CB-01…CB-11 · the Chat Board. A bottom sheet behind a handle row on mobile, a
// 360 px right panel (collapsible to a rail) at ≥ 1024 px. Same content in both.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as Tabs from '@radix-ui/react-tabs'
import { useQueryClient } from '@tanstack/react-query'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/toast'
import { usePersonalBoard, useSharedBoard, useSquad, type Tile } from '../../lib/api'
import { ApiError, request } from '../../lib/http'
import { readLocal, useDesktop, writeLocal } from '../../lib/media'
import { loginUrl } from '../../lib/session'
import { useSwipeDown } from '../../lib/gestures'
import { psnCooldown, slowToast, useCooldown } from '../../lib/send'
import { setPanelCollapsed, usePanelCollapsed } from './panelState'
import { TileButton, type BoardMode } from './TileButton'
import { Composer } from './Composer'
import { AddTileDialog, RemoveTileDialog } from './TileDialogs'

export type BoardId = 'shared' | 'mine'

// The tab survives the sheet closing and a reload.
const TAB_KEY = 'crcmz_app_board_tab'
let boardTab: BoardId = readLocal<BoardId>(TAB_KEY, 'shared') === 'mine' ? 'mine' : 'shared'
const tabListeners = new Set<() => void>()
function setBoardTab(t: BoardId) { boardTab = t; writeLocal(TAB_KEY, t); tabListeners.forEach((l) => l()) }
function useBoardTab() {
  return useSyncExternalStore((cb) => { tabListeners.add(cb); return () => { tabListeners.delete(cb) } }, () => boardTab)
}

/** Shared order is per device, in the same key the classic board uses (`cb_order`). */
const SHARED_ORDER_KEY = 'cb_order'
function restoreOrder(list: Tile[], saved: string[]): Tile[] {
  if (!saved.length) return list
  const rank = new Map(saved.map((l, i) => [l, i]))
  return list
    .map((b, i) => ({ b, r: rank.has(b.label) ? rank.get(b.label)! : saved.length + i }))
    .sort((x, y) => x.r - y.r)
    .map((x) => x.b)
}

/** Roast path tiles are not rendered in /app (owner decision O-1). */
const visible = (t: Tile) => !(t.path && t.path.startsWith('/roast/'))

export function ChatBoard() {
  const desktop = useDesktop()
  return desktop ? <ChatPanel /> : <ChatSheet />
}

// ── Mobile: handle row + sheet ───────────────────────────────────────────────
function ChatSheet() {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const swipe = useSwipeDown(() => (expanded ? setExpanded(false) : setOpen(false)))
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <div className="handle-row">
        <Dialog.Trigger asChild>
          <button type="button" className="handle-btn">
            <span className="sheet-knob" aria-hidden="true" />
            <Icon name="chat" />
            Chat
            <span className="sr-only">Board: open the soundboard and quick message</span>
            <Icon name="up" className="nav-icon chev" />
          </button>
        </Dialog.Trigger>
      </div>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="sheet board-sheet" data-expanded={expanded} aria-describedby={undefined}>
          <div className="sheet-knob-row" {...swipe}><span className="sheet-knob" /></div>
          <Board
            title={<Dialog.Title className="board-title">Chat Board</Dialog.Title>}
            actions={
              <>
                <button type="button" className="icon-btn" aria-pressed={expanded} aria-label={expanded ? 'Shrink Chat Board' : 'Expand Chat Board'} onClick={() => setExpanded((v) => !v)}>
                  <Icon name={expanded ? 'collapse' : 'expand'} />
                </button>
                <Dialog.Close asChild>
                  <button type="button" className="icon-btn" aria-label="Close Chat Board"><Icon name="close" /></button>
                </Dialog.Close>
              </>
            }
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// ── Desktop: right panel, collapsible to a rail ──────────────────────────────
function ChatPanel() {
  const collapsed = usePanelCollapsed()
  const expandRef = useRef<HTMLButtonElement>(null)
  const collapseRef = useRef<HTMLButtonElement>(null)
  const toggled = useRef(false)
  useEffect(() => {
    if (!toggled.current) return
    ;(collapsed ? expandRef : collapseRef).current?.focus()
  }, [collapsed])
  const toggle = (v: boolean) => { toggled.current = true; setPanelCollapsed(v) }

  if (collapsed) {
    return (
      <aside className="chat-panel chrome" aria-label="Chat Board" data-collapsed="true">
        <button ref={expandRef} type="button" className="icon-btn" aria-expanded="false" aria-controls="chat-panel-body" aria-label="Expand Chat Board" onClick={() => toggle(false)}>
          <Icon name="left" />
        </button>
        <button type="button" className="icon-btn" aria-label="Open Chat Board" onClick={() => toggle(false)}>
          <Icon name="chat" />
        </button>
        <span className="rail-label" aria-hidden="true">Chat Board</span>
      </aside>
    )
  }
  return (
    <aside className="chat-panel chrome" aria-label="Chat Board" data-collapsed="false">
      <div id="chat-panel-body" className="board" style={{ minHeight: 0 }}>
        <Board
          title={<h2 className="board-title">Chat Board</h2>}
          actions={
            <button ref={collapseRef} type="button" className="icon-btn" aria-expanded="true" aria-controls="chat-panel-body" aria-label="Collapse Chat Board" onClick={() => toggle(true)}>
              <Icon name="right" />
            </button>
          }
        />
      </div>
    </aside>
  )
}

// ── The board itself ─────────────────────────────────────────────────────────
type Fly = { key: number; text: string; avatar: string | null; name: string }

function Board({ title, actions }: { title: ReactNode; actions: ReactNode }) {
  const tab = useBoardTab()
  const [mode, setMode] = useState<BoardMode>('fire')
  const [fly, setFly] = useState<Fly | null>(null)
  const squad = useSquad()
  const cooldown = useCooldown(psnCooldown)

  // Switching boards leaves Edit/Organize: a mode never carries over unseen.
  useEffect(() => { setMode('fire') }, [tab])

  const modAvatar = squad.data?.squad.find((m) => (m.online_id || '').toLowerCase() === 'crcmz-mod')?.avatar || null
  const showFly = (text: string, who: 'mod' | 'me', myAvatar?: string | null) =>
    setFly({ key: Date.now(), text, avatar: who === 'mod' ? modAvatar : myAvatar ?? null, name: who === 'mod' ? 'CRCMZ MOD' : 'You' })

  return (
    <Tabs.Root value={tab} onValueChange={(v) => setBoardTab(v === 'mine' ? 'mine' : 'shared')} className="board">
      <div className="board-head">
        <div className="sheet-title-row">
          {title}
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>{actions}</div>
        </div>
        <Tabs.List className="seg" aria-label="Which board">
          <Tabs.Trigger className="seg-tab" value="shared">Shared</Tabs.Trigger>
          <Tabs.Trigger className="seg-tab" value="mine">Mine</Tabs.Trigger>
        </Tabs.List>
      </div>
      <Tabs.Content value="shared" className="board" style={{ minHeight: 0 }}>
        <SharedBoard mode={mode} setMode={setMode} onSent={(t) => showFly(t, 'mod')} cooldown={cooldown} />
      </Tabs.Content>
      <Tabs.Content value="mine" className="board" style={{ minHeight: 0 }}>
        <MineBoard mode={mode} setMode={setMode} onSent={(t) => showFly(t, 'mod')} cooldown={cooldown} />
      </Tabs.Content>
      <div className="flyout-layer" aria-hidden="true">
        {fly && (
          <div key={fly.key} className="flyout" onAnimationEnd={() => setFly(null)}>
            {fly.avatar ? <img src={fly.avatar} alt="" referrerPolicy="no-referrer" /> : <span className="fly-av" />}
            <span className="fly-text">{fly.text}</span>
            <span className="fly-tick">✓</span>
          </div>
        )}
      </div>
      <Composer onSent={(t, avatar) => showFly(t, 'me', avatar)} />
    </Tabs.Root>
  )
}

type BoardProps = { mode: BoardMode; setMode: (m: BoardMode) => void; onSent: (text: string) => void; cooldown: number }

function SharedBoard(props: BoardProps) {
  const q = useSharedBoard()
  const [savedOrder, setSavedOrder] = useState<string[]>(() => readLocal<string[]>(SHARED_ORDER_KEY, []))
  const tiles = useMemo(() => restoreOrder((q.data?.buttons ?? []).filter(visible), Array.isArray(savedOrder) ? savedOrder : []), [q.data, savedOrder])
  return (
    <TileBoard
      {...props}
      board="shared"
      tiles={tiles}
      loading={q.isPending}
      error={q.isError && !q.data}
      onRetry={() => q.refetch()}
      canAdd
      removable={(t) => Boolean(t.custom)}
      saveOrder={async (labels) => {
        writeLocal(SHARED_ORDER_KEY, labels)
        setSavedOrder(labels)
        toast('Order saved on this device.', 'success')
        return true
      }}
    />
  )
}

function MineBoard(props: BoardProps) {
  const q = usePersonalBoard()
  const qc = useQueryClient()
  if (q.data && !q.data.signed_in) {
    return (
      <div className="board-scroll">
        <div className="empty">
          <p className="empty-title">Sign in to build it</p>
          <p className="dim" style={{ margin: 0 }}>Your own tiles live here. They still fire into the group.</p>
          <a className="btn btn-secondary" href={loginUrl()}>Sign in</a>
        </div>
      </div>
    )
  }
  return (
    <TileBoard
      {...props}
      board="mine"
      tiles={(q.data?.buttons ?? []).filter(visible)}
      loading={q.isPending}
      error={q.isError && !q.data}
      onRetry={() => q.refetch()}
      canAdd
      removable={() => true}
      emptyText="Your own tiles live here. They still fire into the group."
      saveOrder={async (labels) => {
        try {
          const d = await request<{ buttons?: Tile[] }>('/api/soundboard/personal/order', { body: { labels } })
          if (d.buttons) qc.setQueryData(['board', 'mine'], { buttons: d.buttons, signed_in: true })
          toast('Order saved to your board.', 'success')
          return true
        } catch (e) {
          toast(e instanceof ApiError && e.status === 401 ? 'Sign in to save your order.' : "The order didn't save. Try again.", 'error')
          return false
        }
      }}
    />
  )
}

function TileBoard({
  board, tiles, loading, error, onRetry, canAdd, removable, emptyText, saveOrder, mode, setMode, onSent, cooldown,
}: BoardProps & {
  board: BoardId
  tiles: Tile[]
  loading: boolean
  error: boolean
  onRetry: () => void
  canAdd: boolean
  removable: (t: Tile) => boolean
  emptyText?: string
  saveOrder: (labels: string[]) => Promise<boolean>
}) {
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<Tile | null>(null)
  const [draft, setDraft] = useState<Tile[] | null>(null) // organize working copy
  const [saving, setSaving] = useState(false)

  const list = mode === 'organize' && draft ? draft : tiles
  const anyRemovable = tiles.some(removable)

  function startOrganize() { setDraft(tiles.slice()); setMode('organize') }
  async function finishOrganize() {
    if (!draft) { setMode('fire'); return }
    const changed = draft.some((t, i) => t.label !== tiles[i]?.label)
    if (!changed) { setDraft(null); setMode('fire'); return }
    setSaving(true)
    const ok = await saveOrder(draft.map((t) => t.label))
    setSaving(false)
    if (ok) { setDraft(null); setMode('fire') }
  }
  function move(i: number, dir: -1 | 1) {
    setDraft((d) => {
      if (!d) return d
      const j = i + dir
      if (j < 0 || j >= d.length) return d
      const next = d.slice()
      ;[next[i], next[j]] = [next[j]!, next[i]!]
      return next
    })
  }

  if (loading) {
    return (
      <div className="board-scroll" aria-busy="true">
        <ul className="tile-grid" aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => <li key={i}><div className="skeleton" style={{ height: 64, borderRadius: 12 }} /></li>)}
        </ul>
      </div>
    )
  }
  if (error) {
    return (
      <div className="board-scroll">
        <div className="error-strip" role="alert">
          <span>Board didn't load</span>
          <button type="button" className="btn btn-secondary" onClick={onRetry}>Retry</button>
        </div>
      </div>
    )
  }

  return (
    <div className="board-scroll">
      <div className="board-controls">
        {mode === 'fire' ? (
          <>
            {anyRemovable && <button type="button" className="btn btn-secondary" onClick={() => setMode('edit')}>Edit</button>}
            {tiles.length > 1 && <button type="button" className="btn btn-secondary" onClick={startOrganize}>Organize</button>}
          </>
        ) : (
          <>
            <span className="board-note grow" data-tone="mode" style={{ margin: 0 }}>
              {mode === 'edit' ? 'Editing. Tiles do not fire.' : 'Organizing. Tiles do not fire.'}
            </span>
            <button
              type="button"
              className="btn btn-secondary"
              aria-disabled={saving}
              onClick={() => (saving ? undefined : mode === 'organize' ? finishOrganize() : setMode('fire'))}
            >
              {saving ? 'Saving…' : 'Done'}
            </button>
          </>
        )}
      </div>
      {cooldown > 0 && mode === 'fire' && (
        <p className="board-note" data-tone="countdown" role="status">{slowToast(cooldown)}</p>
      )}
      {list.length === 0 && emptyText && mode === 'fire' && <p className="board-note dim">{emptyText}</p>}
      <ul className="tile-grid" aria-label={board === 'shared' ? 'Shared tiles' : 'My tiles'}>
        {list.map((t, i) => (
          <li key={`${t.label}\u0000${t.msg}\u0000${i}`} className="tile-cell">
            <TileButton
              id={`${board}:${t.label}:${t.msg}`}
              tile={t}
              mode={mode}
              removable={removable(t)}
              onSent={onSent}
              onRemove={() => setRemoving(t)}
              onMove={(dir) => move(i, dir)}
              first={i === 0}
              last={i === list.length - 1}
            />
          </li>
        ))}
        {canAdd && mode === 'fire' && (
          <li className="tile-cell">
            <button type="button" className="tile add" onClick={() => setAdding(true)}>
              <span className="tile-label">+ Custom</span>
            </button>
          </li>
        )}
      </ul>
      <AddTileDialog board={board} open={adding} onOpenChange={setAdding} onSent={onSent} />
      <RemoveTileDialog board={board} tile={removing} onClose={() => setRemoving(null)} />
    </div>
  )
}
