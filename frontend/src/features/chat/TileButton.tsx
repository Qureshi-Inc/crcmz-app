// One Chat Board tile (DESIGN.md §Soundboard button). Fires on a click, which a
// touch scroll that starts on the tile cancels, so a scroll never sends. Never fires
// in Edit or Organize mode. The label is user text and is only ever rendered as text.
import type { Tile } from '../../lib/api'
import { SEND_LABEL, slowLabel } from '../../lib/send'
import { Icon } from '../../components/Icon'
import { usePsnControl } from './usePsnControl'

export type BoardMode = 'fire' | 'edit' | 'organize'

const CLASSES = new Set(['c1', 'c2', 'c3', 'c4', 'c5'])

export function TileButton({
  id, tile, mode, removable, onSent, onRemove, onMove, first, last,
}: {
  id: string
  tile: Tile
  mode: BoardMode
  removable: boolean
  onSent: (text: string) => void
  onRemove: () => void
  onMove: (dir: -1 | 1) => void
  first: boolean
  last: boolean
}) {
  const ctl = usePsnControl(id)
  const cls = tile.cls && CLASSES.has(tile.cls) ? tile.cls : 'c1'

  if (mode !== 'fire') {
    return (
      <>
        <div className={`tile ${cls}`} data-mode={mode}>
          <span className="tile-label">{tile.label}</span>
        </div>
        {mode === 'edit' && removable && (
          <button type="button" className="tile-remove" aria-label={`Remove ${tile.label}`} onClick={onRemove}>
            <Icon name="close" />
          </button>
        )}
        {mode === 'organize' && (
          <div className="tile-tools">
            <button type="button" className="icon-btn" aria-label={`Move ${tile.label} earlier`} aria-disabled={first} onClick={() => !first && onMove(-1)}>
              <Icon name="left" />
            </button>
            <button type="button" className="icon-btn" aria-label={`Move ${tile.label} later`} aria-disabled={last} onClick={() => !last && onMove(1)}>
              <Icon name="right" />
            </button>
          </div>
        )}
      </>
    )
  }

  const fired = ctl.state === 'sent'
  const locked = ctl.locked && !ctl.busy

  async function onClick() {
    if (ctl.locked) return
    // A tile with `path` POSTs that path instead of a message (CB-02).
    const out = tile.path
      ? await ctl.fire(tile.path, {}, { sentMs: 1200, sentAnnouncement: `Sent: ${tile.label}` })
      : await ctl.fire('/v2/squad', { message: tile.msg }, { sentMs: 1200, sentAnnouncement: `Sent: ${tile.msg}` })
    if (out?.kind === 'sent') onSent(tile.msg || tile.label)
  }

  let sub: string = ''
  if (ctl.state === 'countdown') sub = slowLabel(ctl.cooldown)
  else if (ctl.state !== 'idle') sub = SEND_LABEL[ctl.state]

  return (
    <button
      type="button"
      className={`tile ${cls}${fired ? ' fired' : ''}`}
      aria-disabled={locked || undefined}
      aria-busy={ctl.busy || undefined}
      data-busy={ctl.busy || undefined}
      onClick={onClick}
    >
      <span className="tile-label">{tile.label}</span>
      <span className="tile-sub" data-send={ctl.state}>
        {ctl.busy && <span className="spinner" aria-hidden="true" style={{ width: 11, height: 11, marginRight: 4, verticalAlign: '-1px' }} />}
        {sub}
      </span>
    </button>
  )
}
