// The camera orbs: you and everyone in the call. Each orb is its own menu
// (mute for me, volume, enlarge, remove). Video only — audio plays through the
// session's hidden <audio> elements, so these can re-render freely.
import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { Icon } from '../../components/Icon'
import { ConfirmDialog } from '../clips/ClipSheet'
import { CAN_VOL, initials, tint } from '../../lib/watch'
import {
  flipCam, fsRoot, joinCall, kick, leaveCall, localMedia, nameOf, peerPref, peerView, setPeerPref, toggleMute, toggleVideo, useWatch, type WatchState,
} from './session'

type Tile = { id: string; me: boolean; name: string; stream: MediaStream | null; video: boolean; badge: string; mod: boolean }

export function useTiles(s: WatchState): Tile[] {
  const me: Tile[] = s.call.on
    ? [{ id: s.clientId, me: true, name: s.myName || 'You', stream: localMedia(), video: !s.call.camOff && !s.call.micOnly, badge: s.call.muted ? '🔇' : '🎤', mod: s.isMod }]
    : []
  const peers = s.roster
    .filter((r) => r.id && r.id !== s.clientId)
    .map((r) => ({ r, v: peerView(r.id) }))
    .filter(({ v }) => v.inCall || v.stream)
    .map(({ r, v }) => ({ id: r.id, me: false, name: nameOf(r.id), stream: v.stream, video: v.video, badge: v.badge, mod: !!r.isMod }))
  return [...me, ...peers]
}

export function Orbs({ variant }: { variant: 'strip' | 'side' | 'top' | 'bottom' }) {
  const s = useWatch()
  const tiles = useTiles(s)
  const [big, setBig] = useState<Record<string, boolean>>({})
  const [grid, setGrid] = useState(false)
  if (!tiles.length) return null
  return (
    <div className={`wp-orbs ${variant === 'strip' ? 'wp-orbs-strip' : `wp-orbs-over wp-orbs-over-${variant}`}`} role="group" aria-label="Cameras">
      <ul className="wp-orb-list">
        {tiles.map((t) => (
          <li key={t.id}>
            <Orb t={t} s={s} big={!!big[t.id]} setBig={(v) => setBig((b) => ({ ...b, [t.id]: v }))} />
          </li>
        ))}
      </ul>
      {tiles.length > 1 || s.call.on ? (
        <button type="button" className="wp-ctl wp-orbs-grid-btn" aria-label="All cameras, full screen" title="All cameras" onClick={() => setGrid(true)}>
          <Icon name="grid" />
        </button>
      ) : null}
      <GridDialog open={grid} onOpenChange={setGrid} tiles={tiles} s={s} />
    </div>
  )
}

function Face({ t, s, mirror }: { t: Tile; s: WatchState; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    if (v.srcObject !== t.stream) v.srcObject = t.stream
    if (t.stream) v.play().catch(() => { /* muted autoplay is allowed; ignore the odd refusal */ })
  }, [t.stream, s.rtc])
  return (
    <span className="wp-face" style={{ background: tint(t.name) }}>
      <video ref={ref} className="wp-face-video" muted playsInline autoPlay hidden={!t.video} data-mirror={!!mirror} />
      {!t.video && <span className="wp-face-initials" aria-hidden="true">{initials(t.name)}</span>}
    </span>
  )
}

function Orb({ t, s, big, setBig }: { t: Tile; s: WatchState; big: boolean; setBig: (v: boolean) => void }) {
  const [kickOpen, setKickOpen] = useState(false)
  const loud = s.loud[t.me ? 'me' : t.id]
  const pref = t.me ? null : peerPref(t.id)
  const state = t.me ? (s.call.muted ? 'mic muted' : 'mic on') : pref?.m ? 'muted for you' : t.badge === '⚠️' ? 'connection failed' : t.badge === '⋯' ? 'connecting' : ''
  return (
    <>
      <Menu.Root>
        <Menu.Trigger asChild>
          <button type="button" className="wp-orb" data-big={big} data-loud={!!loud} aria-label={`${t.me ? 'You' : t.name}${state ? `, ${state}` : ''}. Options`}>
            <Face t={t} s={s} mirror={t.me && s.call.facing === 'user'} />
            {t.badge && <span className="wp-orb-badge" aria-hidden="true">{pref?.m ? '🔇' : t.badge}</span>}
            <span className="wp-orb-name">{t.me ? 'You' : t.name}</span>
          </button>
        </Menu.Trigger>
        <Menu.Portal container={fsRoot()}>
          <Menu.Content className="menu-content wp-orb-menu" sideOffset={6} align="start" collisionPadding={8}>
            <Menu.Label className="menu-label meta">{t.me ? 'You' : t.name}</Menu.Label>
            {t.me ? (
              <>
                <Menu.Item className="menu-item" onSelect={toggleMute}><Icon name={s.call.muted ? 'mic' : 'micOff'} />{s.call.muted ? 'Unmute mic' : 'Mute mic'}</Menu.Item>
                {!s.call.micOnly && <Menu.Item className="menu-item" onSelect={toggleVideo}><Icon name={s.call.camOff ? 'cam' : 'camOff'} />{s.call.camOff ? 'Turn camera on' : 'Turn camera off'}</Menu.Item>}
                {!s.call.micOnly && <Menu.Item className="menu-item" onSelect={() => void flipCam()} disabled={s.call.busy}><Icon name="flip" />Flip camera</Menu.Item>}
                <Menu.Item className="menu-item" onSelect={() => setBig(!big)}><Icon name={big ? 'collapse' : 'expand'} />{big ? 'Shrink tile' : 'Enlarge tile'}</Menu.Item>
                <Menu.Item className="menu-item menu-item-danger" onSelect={leaveCall}><Icon name="leave" />Leave call</Menu.Item>
              </>
            ) : (
              <>
                <Menu.Item className="menu-item" onSelect={() => setPeerPref(t.id, { m: !pref!.m })}><Icon name={pref!.m ? 'vol' : 'volMute'} />{pref!.m ? 'Unmute for me' : 'Mute for me'}</Menu.Item>
                {CAN_VOL ? (
                  <div className="menu-range" onKeyDown={(e) => e.stopPropagation()}>
                    <label className="meta" htmlFor={`wp-pv-${t.id}`}>Volume for {t.name}</label>
                    <input
                      id={`wp-pv-${t.id}`} type="range" className="wp-range" min={0} max={100} step={1} value={Math.round(pref!.v * 100)}
                      onChange={(e) => setPeerPref(t.id, { v: Number(e.target.value) / 100 })}
                    />
                  </div>
                ) : <p className="menu-note meta">Use your phone's volume buttons for level.</p>}
                <Menu.Item className="menu-item" onSelect={() => setBig(!big)}><Icon name={big ? 'collapse' : 'expand'} />{big ? 'Shrink tile' : 'Enlarge tile'}</Menu.Item>
                {s.isMod && !t.mod && <Menu.Item className="menu-item menu-item-danger" onSelect={() => setKickOpen(true)}><Icon name="kick" />Remove from party</Menu.Item>}
              </>
            )}
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      {!t.me && (
        <ConfirmDialog
          open={kickOpen} onOpenChange={setKickOpen} title="Remove from party?" action="Remove"
          body={<p>Remove this {t.name} session from the watch party? Their other devices stay, and they can rejoin by reloading.</p>}
          onConfirm={() => kick(t.id, t.name)} container={fsRoot()}
        />
      )}
    </>
  )
}

function GridDialog({ open, onOpenChange, tiles, s }: { open: boolean; onOpenChange: (v: boolean) => void; tiles: Tile[]; s: WatchState }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal container={fsRoot()}>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="wp-grid-dialog" aria-describedby={undefined}>
          <div className="sheet-title-row">
            <Dialog.Title className="sheet-title">Cameras</Dialog.Title>
            <span className="wp-grid-actions">
              {s.call.on && !s.call.micOnly && <button type="button" className="icon-btn" aria-label="Flip camera" onClick={() => void flipCam()} disabled={s.call.busy}><Icon name="flip" /></button>}
              {s.call.on && <button type="button" className="icon-btn" aria-label={s.call.muted ? 'Unmute mic' : 'Mute mic'} aria-pressed={!s.call.muted} onClick={toggleMute}><Icon name={s.call.muted ? 'micOff' : 'mic'} /></button>}
              {!s.call.on && <button type="button" className="btn btn-primary" onClick={() => void joinCall()}><Icon name="cam" />Join</button>}
              <Dialog.Close asChild>
                <button type="button" className="icon-btn" aria-label="Close cameras"><Icon name="close" /></button>
              </Dialog.Close>
            </span>
          </div>
          <ul className="wp-grid" data-n={Math.min(tiles.length, 6)}>
            {tiles.map((t) => (
              <li key={t.id} className="wp-grid-tile" data-loud={!!s.loud[t.me ? 'me' : t.id]}>
                <Face t={t} s={s} mirror={t.me && s.call.facing === 'user'} />
                <span className="wp-grid-name">{t.me ? 'You' : t.name}{t.badge ? ` ${t.badge}` : ''}</span>
              </li>
            ))}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
