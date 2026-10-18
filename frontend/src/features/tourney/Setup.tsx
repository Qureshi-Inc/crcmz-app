// The line-up before kick-off: pick players (squad or guests), build teams,
// order the seeds, then start. Solo modes enter each player as their own entrant.
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/toast'
import { api, usePeople, useCatalog, type Entrant, type Person, type Tournament } from '../../lib/tourney'
import { errText } from './Report'

export function Setup({ t, managing = false }: { t: Tournament; managing?: boolean }) {
  const qc = useQueryClient()
  const people = usePeople()
  const cat = useCatalog()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [teamName, setTeamName] = useState('')
  const [editing, setEditing] = useState<Entrant | null>(null)
  const solo = t.team_size === 1
  const taken = new Set(t.entrants.flatMap((e) => e.members.map((m) => m.id)))
  const pool = (people.data ?? []).filter((p) => !(p.player_id && taken.has(p.player_id)))
  const need = t.format === 'groups' ? 4 : 2

  const run = async (fn: () => Promise<Tournament>, ok?: string) => {
    setBusy(true); setErr('')
    try {
      const next = await fn()
      qc.setQueryData(['tourney', 't', t.id], next)
      qc.invalidateQueries({ queryKey: ['tourney', 'list'] })
      qc.invalidateQueries({ queryKey: ['tourney', 'people'] })
      if (ok) toast(ok, 'success')
      return true
    } catch (e) { setErr(errText(e)); return false } finally { setBusy(false) }
  }
  const toggle = (k: string) => setPicked((xs) => (xs.includes(k) ? xs.filter((x) => x !== k) : [...xs, k]))

  const add = async () => {
    const entries = solo ? picked.map((k) => ({ members: [k] })) : [{ name: teamName, members: picked }]
    if (await run(() => api.addEntrants(t.id, entries))) { setPicked([]); setTeamName('') }
  }
  const move = (i: number, d: -1 | 1) => {
    const ids = t.entrants.map((e) => e.id)
    const j = i + d
    if (j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j]!, ids[i]!]
    void run(() => api.seed(t.id, { order: ids }))
  }

  return (
    <div className="su">
      <section className="glass su-card">
        <div className="card-head">
          <h2 className="section-h2">{solo ? 'Players' : 'Teams'} <span className="dim num">{t.entrants.length}</span></h2>
          {!managing && t.entrants.length > 1 && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void run(() => api.seed(t.id, { shuffle: true }), 'Seeds shuffled')}>
            <Icon name="shuffle" className="btn-ico" />Shuffle seeds</button>}
        </div>
        {t.entrants.length === 0 ? <p className="su-empty meta">No one yet. Pick {solo ? 'players' : 'a team'} below.</p> : (
          <ol className="su-list">
            {t.entrants.map((e, i) => (
              <li key={e.id} className="su-row">
                <span className="su-seed num">{i + 1}</span>
                <span className="dot dot-lg" style={{ background: e.color }} />
                <span className="su-main">
                  <span className="su-name">{e.name}</span>
                  {!solo && <span className="meta">{e.members.map((m) => m.display_name).join(', ') || 'No players'} · {e.members.length}/{t.team_size}</span>}
                  {solo && e.members[0]?.psn_id && <span className="meta">PSN {e.members[0].psn_id}</span>}
                </span>
                <span className="su-acts">
                  <button type="button" className="icon-btn" aria-label={`Move ${e.name} up`} disabled={busy || i === 0} onClick={() => move(i, -1)}><Icon name="up" /></button>
                  <button type="button" className="icon-btn" aria-label={`Move ${e.name} down`} disabled={busy || i === t.entrants.length - 1} onClick={() => move(i, 1)}><Icon name="down" /></button>
                  <button type="button" className="icon-btn" aria-label={`Edit ${e.name}`} onClick={() => { setEditing(e); setTeamName(e.name); setPicked(e.members.map((m) => (people.data ?? []).find((x) => x.player_id === m.id)?.key ?? `p:${m.id}`)) }}><Icon name="edit" /></button>
                  <button type="button" className="icon-btn" aria-label={`Remove ${e.name}`} disabled={busy} onClick={() => void run(() => api.removeEntrant(e.id))}><Icon name="trash" /></button>
                </span>
              </li>
            ))}
          </ol>
        )}
        {!managing && <p className="meta su-hint">Seed 1 is the favourite: top seeds meet late and get any byes.</p>}
      </section>

      <section className="glass su-card">
        <div className="card-head">
          <h2 className="section-h2">{editing ? `Edit ${editing.name}` : solo ? 'Add players' : 'New team'}</h2>
          {!solo && !editing && <span className="meta">{picked.length}/{t.team_size} picked</span>}
        </div>
        <div className="su-pick">
          {(!solo || editing) && (
            <div className="su-team-row">
              <input className="input" maxLength={32} placeholder={solo ? 'Name' : 'Team name (optional, defaults to the players)'} value={teamName} onChange={(e) => setTeamName(e.target.value)} aria-label={solo ? 'Player name' : 'Team name'} />
              {editing && (
                <div className="su-colors" role="radiogroup" aria-label="Team colour">
                  {(cat.data?.colors ?? []).map((c) => (
                    <button key={c} type="button" role="radio" aria-checked={editing.color === c} aria-label={c} className="su-color" style={{ background: c }}
                      onClick={() => void run(() => api.editEntrant(editing.id, { color: c })).then(() => setEditing({ ...editing, color: c }))} />
                  ))}
                </div>
              )}
            </div>
          )}
          {!(solo && editing) && <PeoplePicker people={editing ? (people.data ?? []).filter((p) => !(p.player_id && taken.has(p.player_id)) || editing.members.some((m) => m.id === p.player_id)) : pool}
            picked={picked} toggle={toggle} loading={people.isLoading} />}
          {!editing && <Guest onAdd={(p) => { qc.invalidateQueries({ queryKey: ['tourney', 'people'] }); toggle(p.key) }} />}
          {err && <p className="form-err" role="alert">{err}</p>}
          <div className="su-btns">
            {editing ? (
              <>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => api.editEntrant(editing.id, solo ? { name: teamName } : { name: teamName, members: picked }), solo ? 'Saved' : 'Team saved').then((ok) => { if (ok) { setEditing(null); setPicked([]); setTeamName('') } })}>Save team</button>
                <button type="button" className="btn btn-ghost" onClick={() => { setEditing(null); setPicked([]); setTeamName('') }}>Cancel</button>
              </>
            ) : (
              <>
                <button type="button" className="btn btn-secondary" disabled={busy || !picked.length} onClick={() => void add()}>
                  <Icon name="plus" className="btn-ico" />{solo ? `Add ${picked.length || ''} ${picked.length === 1 ? 'player' : 'players'}` : 'Add team'}
                </button>
                {!solo && (
                  <button type="button" className="btn btn-ghost" disabled={busy || picked.length < t.team_size * 2}
                    onClick={() => void run(() => api.autoTeams(t.id, picked), 'Teams made').then((ok) => ok && setPicked([]))}>
                    <Icon name="shuffle" className="btn-ico" />{picked.length >= t.team_size * 2 ? `Shuffle ${picked.length} into teams` : `Pick ${t.team_size * 2}+ to shuffle into teams`}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </section>

      {!managing && (
        <div className="su-start">
          <button type="button" className="btn btn-primary" disabled={busy || t.entrants.length < need}
            onClick={() => void run(() => api.start(t.id), 'Tournament started')}>
            <Icon name="play" className="btn-ico" />Start tournament
          </button>
          {t.entrants.length < need && <span className="meta">Needs at least {need} {solo ? 'players' : 'teams'}</span>}
        </div>
      )}
    </div>
  )
}

function PeoplePicker({ people, picked, toggle, loading }: { people: Person[]; picked: string[]; toggle: (k: string) => void; loading: boolean }) {
  if (loading) return <p className="meta">Loading the squad…</p>
  if (!people.length) return <p className="meta">Everyone's in. Add a guest below.</p>
  return (
    <div className="su-people" role="group" aria-label="Players">
      {people.map((p) => (
        <button key={p.key} type="button" className="chip" aria-pressed={picked.includes(p.key)} onClick={() => toggle(p.key)}>
          {p.display_name}{p.is_guest && <span className="chip-n">guest</span>}
        </button>
      ))}
    </div>
  )
}

function Guest({ onAdd }: { onAdd: (p: Person) => void }) {
  const [name, setName] = useState('')
  const [psn, setPsn] = useState('')
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState('')
  if (!open) return <button type="button" className="btn btn-ghost su-guest-open" onClick={() => setOpen(true)}><Icon name="user" className="btn-ico" />Someone new? Add a guest</button>
  const save = async () => {
    try { onAdd(await api.guest(name, psn)); setName(''); setPsn(''); setOpen(false); setErr('') } catch (e) { setErr(errText(e)) }
  }
  return (
    <div className="su-guest">
      <input className="input" maxLength={40} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Guest name" />
      <input className="input" maxLength={32} placeholder="PSN ID (helps the AI read screenshots)" value={psn} onChange={(e) => setPsn(e.target.value)} aria-label="Guest PSN ID" />
      <button type="button" className="btn btn-secondary" disabled={!name.trim()} onClick={() => void save()}>Add guest</button>
      {err && <p className="form-err" role="alert">{err}</p>}
    </div>
  )
}
