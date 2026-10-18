// Reporting a result: per-game scores (series, two legs), penalties, a live
// verdict, and "read the screenshot" which asks the AI and prefills everything.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useQueryClient } from '@tanstack/react-query'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/toast'
import { useDesktop } from '../../lib/media'
import { ApiError } from '../../lib/http'
import { api, fileToJpeg, type Entrant, type GameScore, type Lobby, type LobbyResult, type Match, type Reading, type Tournament } from '../../lib/tourney'

export function Sheet({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (v: boolean) => void; title: string; children: ReactNode }) {
  const desktop = useDesktop()
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className={desktop ? 'dialog dialog-wide' : 'sheet sheet-clip'} aria-describedby={undefined}>
          {!desktop && <div className="sheet-knob-row" aria-hidden="true"><span className="sheet-knob" /></div>}
          <div className="sheet-title-row">
            <Dialog.Title className="sheet-title">{title}</Dialog.Title>
            <Dialog.Close asChild><button type="button" className="icon-btn" aria-label="Close"><Icon name="close" /></button></Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export const errText = (e: unknown) => (e instanceof ApiError ? e.detail || `Error ${e.status}` : (e as Error)?.message || 'Something went wrong')

type Row = { s1: string; s2: string; map: string }
const num = (v: string) => (v.trim() === '' ? null : Number.parseInt(v, 10))

function verdict(t: Tournament, m: Match, rows: Row[], pens: [string, string]) {
  const knockout = m.stage !== 'R' && m.stage !== 'G'
  const legs = t.settings.legs === 2 && knockout
  const bo = legs ? 1 : t.settings.best_of
  const playAll = !legs && t.settings.round_bo > 1 && bo > 1
  // For play-all nested series: require all bo entries before counting
  if (playAll && rows.length < bo)
    return { ok: false, text: `Fill in series ${rows.length + 1} of ${bo}`, needPens: false, more: true }
  const g = rows.map((r) => ({ s1: num(r.s1), s2: num(r.s2) }))
  if (g.some((x) => x.s1 == null || x.s2 == null || Number.isNaN(x.s1) || Number.isNaN(x.s2))) return { ok: false, text: 'Fill in every score', needPens: false }
  const games = g as { s1: number; s2: number }[]
  let a: number, b: number
  if (legs || bo === 1) {
    a = games.reduce((s, x) => s + x.s1, 0); b = games.reduce((s, x) => s + x.s2, 0)
    if (a !== b) return { ok: true, text: `${a}–${b}${legs ? ' on aggregate' : ''}`, side: a > b ? 1 : 2, needPens: false }
    if (!knockout && t.draws) return { ok: true, text: `${a}–${b} draw`, side: 0, needPens: false }
    if (!t.pens) return { ok: false, text: `${t.mode_label} can't end level`, needPens: false }
    const p1 = num(pens[0]), p2 = num(pens[1])
    if (p1 == null || p2 == null || p1 === p2) return { ok: false, text: 'Level. Enter the penalty shoot-out', needPens: true }
    return { ok: true, text: `${a}–${b}, ${p1}–${p2} on penalties`, side: p1 > p2 ? 1 : 2, needPens: true }
  }
  let w1 = 0, w2 = 0
  for (const x of games) {
    if (x.s1 === x.s2) return { ok: false, text: 'A series can\'t be level', needPens: false }
    if (x.s1 > x.s2) w1++; else w2++
  }
  if (playAll) {
    if (w1 === w2) return { ok: false, text: 'Series tied — check the results', needPens: false }
    return { ok: true, text: `${w1}–${w2} in series`, side: w1 > w2 ? 1 : 2, needPens: false }
  }
  const need = Math.floor(bo / 2) + 1
  if (w1 < need && w2 < need) return { ok: false, text: `Best of ${bo}: first to ${need}. Add the next game`, needPens: false, more: true }
  return { ok: true, text: `${w1}–${w2} in games`, side: w1 > w2 ? 1 : 2, needPens: false }
}

export function ReportMatch({ t, m, shotId, prefill, onClose }: {
  t: Tournament; m: Match; shotId?: string; prefill?: { games: { s1: number | null; s2: number | null }[]; pens?: number[] | null }; onClose: () => void
}) {
  const qc = useQueryClient()
  const ents = new Map(t.entrants.map((e) => [e.id, e]))
  const e1 = ents.get(m.e1 ?? '')!, e2 = ents.get(m.e2 ?? '')!
  const knockout = m.stage !== 'R' && m.stage !== 'G'
  const legs = t.settings.legs === 2 && knockout
  const nestedSeries = t.settings.round_bo > 1 && t.settings.best_of > 1 && !legs
  const startRows = (): Row[] => {
    const src = prefill?.games?.length ? prefill.games : m.games.length ? m.games : (m.partial ?? [])
    const toRow = (g: { s1: number | null; s2: number | null }) => ({ s1: g.s1 == null ? '' : String(g.s1), s2: g.s2 == null ? '' : String(g.s2), map: (g as GameScore).map ?? '' })
    if (nestedSeries) {
      // Always show all bo slots; pre-fill completed series from partial
      const filled = src.map(toRow)
      const extra = Math.max(0, t.settings.best_of - filled.length)
      return [...filled, ...Array.from({ length: extra }, () => ({ s1: '', s2: '', map: '' }))]
    }
    if (src.length) return src.map(toRow)
    return Array.from({ length: legs ? 2 : t.settings.best_of > 1 ? Math.floor(t.settings.best_of / 2) + 1 : 1 }, () => ({ s1: '', s2: '', map: '' }))
  }
  const [rows, setRows] = useState<Row[]>(startRows)
  const [pens, setPens] = useState<[string, string]>(() => {
    const p = prefill?.pens ?? (m.pens1 != null ? [m.pens1, m.pens2] : null)
    return p && p[0] != null && p[1] != null ? [String(p[0]), String(p[1])] : ['', '']
  })
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)
  const [read, setRead] = useState<{ reading: Reading; oriented: boolean } | null>(null)
  const [err, setErr] = useState('')
  const v = useMemo(() => verdict(t, m, rows, pens), [t, m, rows, pens])
  const file = useRef<HTMLInputElement>(null)
  // For non-nested series: auto-append when tied and more games needed
  useEffect(() => {
    if (!nestedSeries && v.more && rows.length < t.settings.best_of) {
      setRows((rs) => rs.length < t.settings.best_of ? [...rs, { s1: '', s2: '', map: '' }] : rs)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.more])

  const save = async () => {
    setBusy(true); setErr('')
    try {
      const games = rows.map((r) => ({ s1: num(r.s1) ?? 0, s2: num(r.s2) ?? 0, map: r.map }))
      const p = v.needPens ? [num(pens[0]), num(pens[1])] : null
      const next = shotId ? await api.applyShot(shotId, { target_id: m.id, games, pens: p }) : await api.report(m.id, games, p)
      qc.setQueryData(['tourney', 't', t.id], next)
      qc.invalidateQueries({ queryKey: ['tourney'] })
      toast(next.champion_id && !t.champion_id ? `${ents.get(next.champion_id)?.name} are champions` : 'Result saved', 'success')
      onClose()
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  const undo = async () => {
    setBusy(true); setErr('')
    try {
      const next = await api.undo(m.id)
      qc.setQueryData(['tourney', 't', t.id], next); qc.invalidateQueries({ queryKey: ['tourney'] })
      toast('Result cleared', 'info'); onClose()
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  const onFile = async (f: File | undefined) => {
    if (!f) return
    setBusy(true); setReading(true); setErr('')
    try {
      const b64 = await fileToJpeg(f)
      const r = await api.read({ image_b64: b64, mime: 'image/jpeg', tournament_id: t.id, target_id: m.id })
      const s = r.suggestion
      if (r.reading.kind !== 'h2h' || !s.found || !s.games?.length) { setErr("The AI couldn't find a final score in that picture. Enter it by hand."); return }
      setRows(s.games.map((g) => ({ s1: g.s1 == null ? '' : String(g.s1), s2: g.s2 == null ? '' : String(g.s2), map: '' })))
      if (s.pens && s.pens.length === 2) setPens([String(s.pens[0]), String(s.pens[1])])
      setRead({ reading: r.reading, oriented: Boolean(s.oriented) })
    } catch (e) { setErr(errText(e)) } finally { setBusy(false); setReading(false); if (file.current) file.current.value = '' }
  }
  const swap = () => {
    setRows((rs) => rs.map((r) => ({ ...r, s1: r.s2, s2: r.s1 })))
    setPens(([a, b]) => [b, a])
    setRead((x) => (x ? { ...x, oriented: true } : x))
  }
  const set = (i: number, k: keyof Row, val: string) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: k === 'map' ? val.slice(0, 32) : val.replace(/\D/g, '').slice(0, 4) } : r)))
  const series = !legs && t.settings.best_of > 1
  const gameName = (i: number) => (legs ? (i === 0 ? '1st leg' : '2nd leg') : nestedSeries ? `Series ${i + 1}` : series ? (t.maps ? `Map ${i + 1}` : `Game ${i + 1}`) : 'Final score')

  return (
    <div className="rp">
      <div className="rp-vs">
        <TeamHead e={e1} side="left" />
        <span className="rp-v eyebrow">vs</span>
        <TeamHead e={e2} side="right" />
      </div>
      <div className="rp-rows">
        {rows.map((r, i) => (
          <div key={i} className="rp-row">
            <span className="rp-label meta">{gameName(i)}</span>
            {t.maps && series && <input className="input rp-map" placeholder="Map (optional)" value={r.map} onChange={(e) => set(i, 'map', e.target.value)} aria-label={`${gameName(i)} map`} />}
            <div className="rp-score">
              <input className="input rp-n num" inputMode="numeric" value={r.s1} onChange={(e) => set(i, 's1', e.target.value)} aria-label={`${e1.name} ${t.unit.toLowerCase()}, ${gameName(i)}`} placeholder="0" />
              <span className="rp-dash" aria-hidden="true">–</span>
              <input className="input rp-n num" inputMode="numeric" value={r.s2} onChange={(e) => set(i, 's2', e.target.value)} aria-label={`${e2.name} ${t.unit.toLowerCase()}, ${gameName(i)}`} placeholder="0" />
            </div>
          </div>
        ))}
        {v.needPens && (
          <div className="rp-row">
            <span className="rp-label meta">Penalties</span>
            <div className="rp-score">
              <input className="input rp-n num" inputMode="numeric" value={pens[0]} onChange={(e) => setPens([e.target.value.replace(/\D/g, '').slice(0, 2), pens[1]])} aria-label={`${e1.name} penalties`} placeholder="0" />
              <span className="rp-dash" aria-hidden="true">–</span>
              <input className="input rp-n num" inputMode="numeric" value={pens[1]} onChange={(e) => setPens([pens[0], e.target.value.replace(/\D/g, '').slice(0, 2)])} aria-label={`${e2.name} penalties`} placeholder="0" />
            </div>
          </div>
        )}
        {series && (
          <div className="rp-tools">
            {rows.length < t.settings.best_of && <button type="button" className="btn btn-ghost" onClick={() => setRows((rs) => [...rs, { s1: '', s2: '', map: '' }])}><Icon name="plus" className="btn-ico" />Add game</button>}
            {rows.length > 1 && <button type="button" className="btn btn-ghost" onClick={() => setRows((rs) => rs.slice(0, -1))}>Remove last</button>}
          </div>
        )}
      </div>
      <p className={`rp-verdict${v.ok ? ' ok' : ''}`} role="status">
        {v.ok && v.side ? <><b>{(v.side === 1 ? e1 : e2).name}</b> win · {v.text}</> : v.text}
      </p>
      {read && (
        <div className="rp-ai">
          <Icon name="cam" className="btn-ico" />
          <span>AI read: {(read.reading.sides ?? []).map((s) => `${s.label ?? '?'} ${s.score ?? '?'}`).join(' – ')}.
            {read.oriented ? ' Sides matched to the players.' : " Couldn't tell who was which side: check the order."}</span>
          <button type="button" className="btn btn-secondary" onClick={swap}>Swap sides</button>
        </div>
      )}
      {err && <p className="form-err" role="alert">{err}</p>}
      <div className="dialog-actions rp-actions">
        <input ref={file} type="file" accept="image/*" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => file.current?.click()}>
          <Icon name="cam" className="btn-ico" />{reading ? 'Reading…' : 'Read screenshot'}
        </button>
        {m.status === 'played' && !shotId && <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void undo()}>Clear result</button>}
        <button type="button" className="btn btn-primary" disabled={busy || !v.ok} onClick={() => void save()}>{busy ? 'Saving…' : 'Save result'}</button>
      </div>
    </div>
  )
}

function TeamHead({ e, side }: { e: Entrant; side: 'left' | 'right' }) {
  return (
    <div className={`rp-team rp-${side}`}>
      <span className="rp-name"><span className="dot" style={{ background: e.color }} />{e.name}</span>
      {e.members.length > 1 && <span className="meta">{e.members.map((p) => p.display_name).join(', ')}</span>}
    </div>
  )
}

type LRow = { entrant_id: string; placement: string; kills: string; deaths: string }

export function ReportLobby({ t, lobby, shotId, prefill, onClose }: {
  t: Tournament; lobby: Lobby; shotId?: string; prefill?: LobbyResult[]; onClose: () => void
}) {
  const qc = useQueryClient()
  const start = (): LRow[] => t.entrants.map((e) => {
    const r = (prefill ?? lobby.results).find((x) => x.entrant_id === e.id)
    return { entrant_id: e.id, placement: r?.placement ? String(r.placement) : '', kills: r ? String(r.kills ?? 0) : '', deaths: r?.deaths != null ? String(r.deaths) : '' }
  })
  const [rows, setRows] = useState<LRow[]>(start)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const file = useRef<HTMLInputElement>(null)
  const s = t.settings
  const pts = (r: LRow) => {
    const p = Number.parseInt(r.placement, 10)
    return (p && p <= s.placement_points.length ? s.placement_points[p - 1]! : 0) + (Number.parseInt(r.kills, 10) || 0) * s.kill_points
  }
  const places = rows.map((r) => r.placement).filter(Boolean)
  const dupe = places.length !== new Set(places).size
  const sorted = [...rows].sort((a, b) => (Number.parseInt(a.placement, 10) || 99) - (Number.parseInt(b.placement, 10) || 99))
  const set = (id: string, k: keyof LRow, val: string) => setRows((rs) => rs.map((r) => (r.entrant_id === id ? { ...r, [k]: val.replace(/\D/g, '').slice(0, 3) } : r)))

  const save = async () => {
    setBusy(true); setErr('')
    try {
      const body = rows.filter((r) => r.placement).map((r) => ({
        entrant_id: r.entrant_id, placement: Number.parseInt(r.placement, 10), kills: Number.parseInt(r.kills, 10) || 0,
        deaths: r.deaths ? Number.parseInt(r.deaths, 10) : null,
      }))
      const next = shotId ? await api.applyShot(shotId, { target_id: lobby.id, rows: body }) : await api.reportLobby(lobby.id, body)
      qc.setQueryData(['tourney', 't', t.id], next); qc.invalidateQueries({ queryKey: ['tourney'] })
      toast(`Game ${lobby.num} saved`, 'success'); onClose()
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  const undo = async () => {
    setBusy(true)
    try {
      const next = await api.undoLobby(lobby.id)
      qc.setQueryData(['tourney', 't', t.id], next); qc.invalidateQueries({ queryKey: ['tourney'] }); onClose()
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  const onFile = async (f: File | undefined) => {
    if (!f) return
    setBusy(true); setErr(''); setNote('')
    try {
      const r = await api.read({ image_b64: await fileToJpeg(f), mime: 'image/jpeg', tournament_id: t.id, target_id: lobby.id })
      const found = r.suggestion.rows ?? []
      if (!found.length) { setErr("The AI couldn't match anyone on that scoreboard. Enter it by hand."); return }
      setRows((rs) => rs.map((row) => {
        const x = found.find((y) => y.entrant_id === row.entrant_id)
        return x ? { ...row, placement: String(x.placement ?? ''), kills: String(x.kills ?? 0), deaths: x.deaths != null ? String(x.deaths) : '' } : row
      }))
      setNote(`AI matched ${found.length} of ${t.entrants.length}. Check anyone it missed.`)
    } catch (e) { setErr(errText(e)) } finally { setBusy(false); if (file.current) file.current.value = '' }
  }

  return (
    <div className="rp">
      <div className="lr-head meta"><span>{t.team_size > 1 ? 'Team' : 'Player'}</span><span>Place</span><span>Kills</span><span>Deaths</span><span>Pts</span></div>
      <ul className="lr-rows">
        {sorted.map((r) => {
          const e = t.entrants.find((x) => x.id === r.entrant_id)!
          return (
            <li key={r.entrant_id} className="lr-row">
              <span className="lr-name"><span className="dot" style={{ background: e.color }} />{e.name}</span>
              <input className="input rp-n num" inputMode="numeric" value={r.placement} placeholder="–" onChange={(ev) => set(r.entrant_id, 'placement', ev.target.value)} aria-label={`${e.name} placement`} />
              <input className="input rp-n num" inputMode="numeric" value={r.kills} placeholder="0" onChange={(ev) => set(r.entrant_id, 'kills', ev.target.value)} aria-label={`${e.name} kills`} />
              <input className="input rp-n num" inputMode="numeric" value={r.deaths} placeholder="–" onChange={(ev) => set(r.entrant_id, 'deaths', ev.target.value)} aria-label={`${e.name} deaths`} />
              <span className="lr-pts num">{r.placement ? pts(r) : '–'}</span>
            </li>
          )
        })}
      </ul>
      {dupe && <p className="form-err" role="alert">Two entries have the same placement</p>}
      {note && <p className="meta">{note}</p>}
      {err && <p className="form-err" role="alert">{err}</p>}
      <div className="dialog-actions rp-actions">
        <input ref={file} type="file" accept="image/*" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => file.current?.click()}><Icon name="cam" className="btn-ico" />Read scoreboard</button>
        {lobby.status === 'played' && !shotId && <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void undo()}>Clear game</button>}
        <button type="button" className="btn btn-primary" disabled={busy || dupe || !places.length} onClick={() => void save()}>{busy ? 'Saving…' : 'Save game'}</button>
      </div>
    </div>
  )
}
