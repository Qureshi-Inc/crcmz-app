// Tourney: per-game tournaments with live brackets, tables and lobby leaderboards.
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useTitle } from '../../app/title'
import { Icon } from '../../components/Icon'
import { ErrorStrip, SkeletonRows } from '../../components/states'
import { toast } from '../../components/toast'
import { api, progressText, useShots, useTournament, useTournaments, type Entrant, type Lobby, type Match, type PlayerRow, type Shot, type Summary, type Tournament } from '../../lib/tourney'
import { Bracket, MatchCard } from './Bracket'
import { Fixtures, Leaderboard, Standings } from './Tables'
import { ReportLobby, ReportMatch, Sheet, errText } from './Report'
import { Setup } from './Setup'
import { Leaders } from './Leaders'
import '../../styles/tourney.css'

export function TourneyPage() {
  useTitle('Tourney')
  const q = useTournaments()
  const list = q.data ?? []
  const live = list.filter((t) => t.status === 'active')
  const draft = list.filter((t) => t.status === 'draft')
  const done = list.filter((t) => t.status === 'complete')
  return (
    <div className="page tn">
      <div className="tn-top">
        <div>
          <h1 className="page-h1" tabIndex={-1}>Tourney</h1>
          <p className="dim tn-sub">Brackets, leagues and lobby series for every game the squad plays.</p>
        </div>
        <div className="tn-owner">
          <Link to="/tourney/leaders" className="btn btn-secondary"><Icon name="giveaway" className="btn-ico" />Leaderboards</Link>
          <Link to="/tourney/new" className="btn btn-primary"><Icon name="plus" className="btn-ico" />New tournament</Link>
        </div>
      </div>
      {q.isError && <ErrorStrip text="Couldn't load tournaments" onRetry={() => q.refetch()} />}
      {q.isLoading && <SkeletonRows n={3} height={88} />}
      {!q.isLoading && !list.length && (
        <div className="empty glass">
          <p className="empty-title">No tournaments yet</p>
          <p className="dim">Pick a game and a mode (FC 1v1, COD Search & Destroy, a Free-for-All lobby series…), add the squad and the chart builds itself.</p>
          <Link to="/tourney/new" className="btn btn-primary">Start one</Link>
        </div>
      )}
      <Group title="Live" items={live} />
      <Group title="Setting up" items={draft} />
      <Group title="Finished" items={done} />
    </div>
  )
}

function Group({ title, items }: { title: string; items: Summary[] }) {
  if (!items.length) return null
  return (
    <section className="tn-group" aria-label={title}>
      <h2 className="eyebrow">{title}</h2>
      <ul className="tn-cards">
        {items.map((t) => (
          <li key={t.id}>
            <Link to={`/tourney/${t.id}`} className="tn-card glass" style={{ ['--gc' as string]: t.game_color }}>
              <span className="tn-card-top">
                <span className="tn-card-game">{t.game_short}</span>
                <span className="meta">{t.mode_label} · {t.format_label}</span>
                {t.status === 'active' && <span className="pill pill-live">Live</span>}
              </span>
              <span className="tn-card-name">{t.name}</span>
              {t.champion ? (
                <span className="tn-card-champ"><Icon name="giveaway" className="btn-ico" /><b>{t.champion.name}</b> won</span>
              ) : (
                <span className="tn-card-prog">
                  <span className="tn-bar" aria-hidden="true"><span style={{ width: `${t.progress.total ? (t.progress.played / t.progress.total) * 100 : 0}%` }} /></span>
                  <span className="meta num">{t.status === 'draft' ? `${t.entrant_count} entered` : progressText(t.kind, t.progress, t.best_of ?? 1, true, t.round_bo ?? 1)}</span>
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

type Tab = 'chart' | 'matches' | 'stats' | 'lineup' | 'shots'

export function TournamentPage() {
  const { id = '' } = useParams()
  const q = useTournament(id)
  const t = q.data
  useTitle(t?.name ?? 'Tourney')
  const [tab, setTab] = useState<Tab>('chart')
  const [pick, setPick] = useState<Match | null>(null)
  const [lobby, setLobby] = useState<Lobby | null>(null)
  const [shotOpen, setShotOpen] = useState<{ shot: Shot; m?: Match; l?: Lobby } | null>(null)
  const shots = useShots(id, Boolean(t && t.status === 'active'))

  if (q.isError) return <div className="page tn"><BackLink /><ErrorStrip text="Couldn't load this tournament" onRetry={() => q.refetch()} /></div>
  if (!t) return <div className="page tn"><BackLink /><SkeletonRows n={4} height={84} /></div>

  const champ = t.entrants.find((e) => e.id === t.champion_id)
  const pending = (shots.data ?? []).filter((s) => s.status === 'pending')
  const onPick = (m: Match) => setPick(m)

  return (
    <div className="page tn">
      <BackLink />
      <header className="tn-head" style={{ ['--gc' as string]: t.game_color }}>
        <span className="tn-head-game">{t.game_label} · {t.mode_label} · {t.format_label}{t.team_size > 1 ? ` · ${t.team_size}v${t.team_size}` : ''}</span>
        <h1 className="page-h1" tabIndex={-1}>{t.name}</h1>
        <div className="tn-head-row">
          {t.status === 'active' && <span className="pill pill-live">Live</span>}
          {t.status === 'complete' && <span className="pill pill-gold">Finished</span>}
          {t.status === 'draft' && <span className="pill">Setting up</span>}
          {t.status !== 'draft' && (
            <span className="tn-head-prog">
              <span className="tn-bar" aria-hidden="true"><span style={{ width: `${t.progress.total ? (t.progress.played / t.progress.total) * 100 : 0}%` }} /></span>
              <span className="meta num">{progressText(t.kind, t.progress, t.settings.legs === 2 ? 2 : t.settings.best_of, false, t.settings.round_bo ?? 1)}</span>
            </span>
          )}
          <RulesLine t={t} />
        </div>
        <Owner t={t} />
      </header>

      {t.status === 'draft' ? <Setup t={t} /> : (
        <>
          <div className="seg tn-tabs" role="tablist" style={{ gridTemplateColumns: `repeat(${t.status === 'active' ? 5 : 4}, 1fr)` }}>
            {(['chart', 'matches', 'stats', 'lineup', ...(t.status === 'active' ? ['shots'] : [])] as Tab[]).map((k) => (
              <button key={k} type="button" role="tab" className="seg-tab" data-state={tab === k ? 'active' : 'inactive'} aria-selected={tab === k} onClick={() => setTab(k)}>
                {{ chart: 'Chart', matches: t.kind === 'ffa' ? 'Games' : 'Matches', stats: 'Stats', lineup: 'Line-up', shots: `Inbox${pending.length ? ` (${pending.length})` : ''}` }[k]}
              </button>
            ))}
          </div>
          {tab === 'chart' && (
            <>
              {champ && <Champion t={t} />}
              <Chart t={t} onPick={onPick} onLobby={setLobby} />
            </>
          )}
          {tab === 'matches' && <MatchList t={t} onPick={onPick} onLobby={setLobby} />}
          {tab === 'stats' && <Leaders tournamentId={t.id} fixedGame={t.game} />}
          {tab === 'lineup' && <Lineup t={t} />}
          {tab === 'shots' && <Shots t={t} shots={shots.data ?? []} onOpen={(s) => {
            const sug = s.suggestion
            const m = t.matches.find((x) => x.id === sug?.target_id)
            const l = t.lobbies.find((x) => x.id === sug?.target_id)
            setShotOpen({ shot: s, m, l })
          }} />}
        </>
      )}

      <Sheet open={Boolean(pick)} onOpenChange={(v) => !v && setPick(null)} title={pick ? `${pick.code} · Report` : ''}>
        {pick && <ReportMatch key={pick.id} t={t} m={pick} onClose={() => setPick(null)} />}
      </Sheet>
      <Sheet open={Boolean(lobby)} onOpenChange={(v) => !v && setLobby(null)} title={lobby ? `Game ${lobby.num}` : ''}>
        {lobby && <ReportLobby key={lobby.id} t={t} lobby={lobby} onClose={() => setLobby(null)} />}
      </Sheet>
      <Sheet open={Boolean(shotOpen)} onOpenChange={(v) => !v && setShotOpen(null)} title="Screenshot from PSN">
        {shotOpen && <ShotApply t={t} {...shotOpen} onClose={() => { setShotOpen(null); void shots.refetch() }} />}
      </Sheet>
    </div>
  )
}

function BackLink() {
  return <Link to="/tourney" className="btn btn-ghost tn-back"><Icon name="left" className="btn-ico" />Tourney</Link>
}

function RulesLine({ t }: { t: Tournament }) {
  const s = t.settings
  const bits: string[] = []
  if (t.kind === 'h2h') {
    if (s.legs === 2) bits.push('home and away knockouts')
    else if (s.best_of > 1) bits.push(`best of ${s.best_of}`)
    if (t.format === 'groups') bits.push(`groups of ${s.group_size}, top ${s.advance} through`)
    if (t.format === 'league' && s.league_legs === 2) bits.push('double round robin')
    if ((t.format === 'league' || t.format === 'groups')) bits.push(`${s.pts_win} pts a win${t.draws ? `, ${s.pts_draw} a draw` : ''}`)
  } else {
    bits.push(`${s.lobbies} games`, s.kill_points ? `${s.kill_points} pt per kill` : 'placement points')
  }
  return <span className="meta">{bits.join(' · ')}</span>
}

function Owner({ t }: { t: Tournament }) {
  const qc = useQueryClient()
  const nav = useNavigate()
  const [confirm, setConfirm] = useState<'' | 'reset' | 'delete'>('')
  const [busy, setBusy] = useState(false)
  if (!t.can_manage) return null
  const go = async () => {
    setBusy(true)
    try {
      if (confirm === 'delete') { await api.remove(t.id); qc.invalidateQueries({ queryKey: ['tourney', 'list'] }); nav('/tourney'); toast('Tournament deleted'); return }
      const next = await api.reset(t.id); qc.setQueryData(['tourney', 't', t.id], next); qc.invalidateQueries({ queryKey: ['tourney', 'list'] }); toast('Back to setup, results cleared')
    } catch (e) { toast(errText(e), 'error') } finally { setBusy(false); setConfirm('') }
  }
  return (
    <div className="tn-owner">
      {confirm ? (
        <>
          <span className="meta">{confirm === 'delete' ? 'Delete this tournament for everyone?' : 'Clear every result and go back to the line-up?'}</span>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void go()}>{confirm === 'delete' ? 'Delete' : 'Reset'}</button>
          <button type="button" className="btn btn-ghost" onClick={() => setConfirm('')}>Cancel</button>
        </>
      ) : (
        <>
          {t.status !== 'draft' && <button type="button" className="btn btn-ghost" onClick={() => setConfirm('reset')}><Icon name="refresh" className="btn-ico" />Reset</button>}
          <button type="button" className="btn btn-ghost" onClick={() => setConfirm('delete')}><Icon name="trash" className="btn-ico" />Delete</button>
        </>
      )}
    </div>
  )
}

function Champion({ t }: { t: Tournament }) {
  const e = t.entrants.find((x) => x.id === t.champion_id)!
  const fin = [...t.matches].reverse().find((m) => m.status === 'played' && m.winner_id === e.id && m.stage !== 'P')
  const other = fin ? t.entrants.find((x) => x.id === (fin.e1 === e.id ? fin.e2 : fin.e1)) : undefined
  const board = t.leaderboard.find((r) => r.entrant_id === e.id)
  return (
    <section className="champ glass" aria-label="Champion">
      <Icon name="giveaway" className="champ-ico" />
      <span className="eyebrow">Champion{t.team_size > 1 ? 's' : ''}</span>
      <span className="champ-name">{e.name}</span>
      {t.team_size > 1 && <span className="dim">{e.members.map((m) => m.display_name).join(' · ')}</span>}
      {fin && other && <span className="meta">Beat {other.name} {fin.e1 === e.id ? `${fin.score1}–${fin.score2}` : `${fin.score2}–${fin.score1}`} in the {fin.stage === 'GF' ? 'grand final' : fin.stage === 'R' ? 'league' : 'final'}</span>}
      {board && <span className="meta">{board.points} pts · {board.kills} kills · {board.wins} game wins</span>}
    </section>
  )
}

function Chart({ t, onPick, onLobby }: { t: Tournament; onPick: (m: Match) => void; onLobby: (l: Lobby) => void }) {
  const ents = new Map(t.entrants.map((e) => [e.id, e]))
  const one = (stage: Match['stage']) => t.matches.filter((m) => m.stage === stage && m.status !== 'void')
  if (t.format === 'ffa') return <Leaderboard t={t} onLobby={onLobby} />
  if (t.format === 'league') return (
    <>
      <Standings t={t} rows={t.tables[''] ?? []} />
      <Fixtures t={t} matches={t.matches.filter((m) => m.stage === 'R')} onPick={onPick} />
    </>
  )
  const extra = (
    <div className="tn-finals">
      {one('GF').map((m) => (
        <div key={m.id} className="tn-final"><h3 className="eyebrow">{m.round === 1 ? 'Grand final' : 'Final reset'}</h3>
          <MatchCard m={m} ents={ents} t={t} onPick={onPick} gold={m.winner_id === t.champion_id && Boolean(t.champion_id)} /></div>
      ))}
      {one('P').map((m) => (
        <div key={m.id} className="tn-final"><h3 className="eyebrow">3rd place</h3><MatchCard m={m} ents={ents} t={t} onPick={onPick} /></div>
      ))}
    </div>
  )
  if (t.format === 'groups') {
    const groups = Object.keys(t.tables)
    return (
      <>
        <div className="tn-groups">
          {groups.map((g) => <Standings key={g} t={t} rows={t.tables[g]!} group={g} qualify={t.settings.advance} />)}
        </div>
        <Bracket t={t} stage="K" onPick={onPick} title="Knockout" />
        {extra}
        <details className="tn-more glass"><summary className="section-h2">Group fixtures</summary>
          {groups.map((g) => <div key={g}><h3 className="eyebrow tn-gh">Group {g}</h3><Fixtures t={t} matches={t.matches.filter((m) => m.stage === 'G' && m.group === g)} onPick={onPick} /></div>)}
        </details>
      </>
    )
  }
  return (
    <>
      <Bracket t={t} stage="W" onPick={onPick} title={t.format === 'double_elim' ? 'Winners bracket' : undefined} />
      {t.format === 'double_elim' && <Bracket t={t} stage="L" onPick={onPick} title="Losers bracket" />}
      {extra}
    </>
  )
}

function MatchList({ t, onPick, onLobby }: { t: Tournament; onPick: (m: Match) => void; onLobby: (l: Lobby) => void }) {
  const ents = new Map(t.entrants.map((e) => [e.id, e]))
  const qc = useQueryClient()
  if (t.kind === 'ffa') {
    return (
      <div className="tn-list">
        {t.lobbies.map((l) => (
          <button key={l.id} type="button" className="tn-lobby glass" onClick={() => onLobby(l)}>
            <span className="section-h2">Game {l.num}</span>
            <span className="meta">{l.status === 'played'
              ? l.results.slice(0, 3).map((r) => `#${r.placement} ${ents.get(r.entrant_id)?.name}`).join(' · ')
              : 'Not played yet. Tap to enter placements'}</span>
            {l.source?.startsWith('screenshot') && <span className="pill">AI</span>}
          </button>
        ))}
        {t.status === 'active' && (
          <button type="button" className="btn btn-ghost" onClick={() => void api.addLobby(t.id).then((n) => qc.setQueryData(['tourney', 't', t.id], n)).catch((e) => toast(errText(e), 'error'))}>
            <Icon name="plus" className="btn-ico" />Add another game</button>
        )}
      </div>
    )
  }
  const real = t.matches.filter((m) => m.status !== 'void' && m.status !== 'bye')
  const next = real.filter((m) => m.playable)
  const later = real.filter((m) => m.status === 'pending' && !m.playable)
  const played = real.filter((m) => m.status === 'played').sort((a, b) => (b.played_at ?? '').localeCompare(a.played_at ?? ''))
  return (
    <div className="tn-list">
      {next.length > 0 && <Rows title="Up next" ms={next} t={t} ents={ents} onPick={onPick} />}
      {played.length > 0 && <Rows title="Results" ms={played} t={t} ents={ents} onPick={onPick} />}
      {later.length > 0 && <Rows title="Waiting on earlier matches" ms={later} t={t} ents={ents} onPick={onPick} />}
    </div>
  )
}

function Rows({ title, ms, t, ents, onPick }: { title: string; ms: Match[]; t: Tournament; ents: Map<string, Tournament['entrants'][number]>; onPick: (m: Match) => void }) {
  const nested = t.settings.round_bo > 1
  return (
    <section>
      <h2 className="eyebrow">{title}</h2>
      <div className="ml-series-list">
        {ms.map((m) => {
          if (nested) return <NestedMatchRow key={m.id} m={m} t={t} ents={ents} onPick={onPick} />
          if (m.status === 'played' || m.playable || m.games.length > 0 || (m.partial ?? []).length > 0)
            return <FlatMatchRow key={m.id} m={m} t={t} ents={ents} onPick={onPick} />
          return <MatchCard key={m.id} m={m} ents={ents} t={t} onPick={onPick} />
        })}
      </div>
    </section>
  )
}

function SeriesStats({ rounds, e1, e2 }: { rounds: { rows?: PlayerRow[] }[]; e1?: Entrant; e2?: Entrant }) {
  const totals = new Map<string, { k: number; d: number; s: 1 | 2 | null }>()
  for (const rd of rounds) {
    for (const p of rd.rows ?? []) {
      if (!p.tag) continue
      const cur = totals.get(p.tag) ?? { k: 0, d: 0, s: null }
      totals.set(p.tag, { k: cur.k + (p.k ?? 0), d: cur.d + (p.d ?? 0), s: cur.s ?? (p.s ?? null) })
    }
  }
  if (!totals.size) return null

  const entries = [...totals.entries()]
  const side1 = entries.filter(([, v]) => v.s === 1).sort((a, b) => b[1].k - a[1].k)
  const side2 = entries.filter(([, v]) => v.s === 2).sort((a, b) => b[1].k - a[1].k)
  const unsided = entries.filter(([, v]) => v.s == null).sort((a, b) => b[1].k - a[1].k)

  const kd = (p: { k: number; d: number }) => p.d ? `${p.k}k / ${p.d}d` : `${p.k}k`

  if (!side1.length && !side2.length) {
    return (
      <div className="ml-nested-stats">
        {[...unsided].map(([tag, p]) => (
          <span key={tag} className="ml-nested-stat">
            <span className="ml-nested-tag">{tag.replace(/#\d+$/, '')}</span>
            <span className="num">{kd(p)}</span>
          </span>
        ))}
      </div>
    )
  }

  const renderSide = (players: typeof entries, e?: Entrant) => (
    <div className="ml-stats-side">
      {e && <span className="ml-stats-label" style={{ color: e.color }}>{e.name}</span>}
      {players.map(([tag, p]) => (
        <div key={tag} className="ml-stats-row">
          <span className="ml-stats-tag">{tag.replace(/#\d+$/, '')}</span>
          <span className="ml-stats-kd num">{kd(p)}</span>
        </div>
      ))}
    </div>
  )

  return (
    <div className="ml-stats-grid">
      {renderSide(side1, e1)}
      {renderSide([...side2, ...unsided], e2)}
    </div>
  )
}

function FlatMatchRow({ m, t, ents, onPick }: { m: Match; t: Tournament; ents: Map<string, Entrant>; onPick: (m: Match) => void }) {
  const e1 = ents.get(m.e1 ?? '')
  const e2 = ents.get(m.e2 ?? '')
  const open = m.playable || (m.status === 'played' && t.status !== 'draft')
  const games = m.status === 'played' ? m.games : (m.partial ?? [])
  const multiGame = t.settings.best_of > 1

  const inner = (
    <div className="ml-nested">
      <div className="ml-nested-head">
        <span className="ml-nested-side">
          <span className="dot" style={{ background: e1?.color ?? 'var(--border-control)' }} />
          <span className={`ml-nested-name${m.status === 'played' && m.winner_id === e1?.id ? ' ml-nested-won' : m.status === 'played' && m.winner_id ? ' ml-nested-lost' : ''}`}>
            {e1?.name ?? m.wait1 ?? 'TBD'}
          </span>
          {m.status === 'played' && <span className="ml-nested-pts num">{m.score1}</span>}
        </span>
        <span className="ml-nested-sep">–</span>
        <span className="ml-nested-side ml-nested-side2">
          {m.status === 'played' && <span className="ml-nested-pts num">{m.score2}</span>}
          <span className={`ml-nested-name${m.status === 'played' && m.winner_id === e2?.id ? ' ml-nested-won' : m.status === 'played' && m.winner_id ? ' ml-nested-lost' : ''}`}>
            {e2?.name ?? m.wait2 ?? 'TBD'}
          </span>
          <span className="dot" style={{ background: e2?.color ?? 'var(--border-control)' }} />
        </span>
      </div>
      {games.length > 0 && (
        <div className="rp-series-breakdown ml-nested-breakdown">
          {games.map((g, i) => {
            const w1 = g.s1 > g.s2
            const winner = w1 ? e1 : e2
            return (
              <div key={i} className="ml-nested-series-item">
                <div className="rp-sb-row">
                  {multiGame && <span className="rp-sb-label">G{i + 1}</span>}
                  <span className="rp-sb-winner" style={{ color: winner?.color }}>{winner?.name}</span>
                  <span className="rp-sb-rounds">
                    <span title={g.map ?? undefined} className={`rp-sb-rd ${w1 ? 'w1' : 'w2'}`}>{g.s1}–{g.s2}</span>
                    {g.map && <span className="rp-sb-map">{g.map}</span>}
                  </span>
                </div>
                {g.rows?.length ? <SeriesStats rounds={[g]} e1={e1} e2={e2} /> : null}
              </div>
            )
          })}
        </div>
      )}
      <div className="ml-nested-meta">
        <span className="meta">{m.code}</span>
        {m.source?.startsWith('screenshot') && <span className="meta"><Icon name="cam" className="btn-ico" />AI</span>}
        {m.playable && <span className="ml-nested-cta">{games.length > 0 ? `Game ${games.length + 1}` : 'Report'}</span>}
      </div>
    </div>
  )

  const cls = `ml-nested-wrap glass${m.playable ? ' ml-nested-ready' : ''}`
  return open
    ? <button type="button" className={cls} onClick={() => onPick(m)}>{inner}</button>
    : <div className={cls}>{inner}</div>
}

function NestedMatchRow({ m, t, ents, onPick }: { m: Match; t: Tournament; ents: Map<string, Entrant>; onPick: (m: Match) => void }) {
  const e1 = ents.get(m.e1 ?? '')
  const e2 = ents.get(m.e2 ?? '')
  const sh = m.series_history ?? []
  const sr = m.series_rounds ?? []
  const open = m.playable || (m.status === 'played' && t.status !== 'draft')
  const s1wins = m.status === 'played' ? (m.score1 ?? 0) : sh.filter((s) => s.won === 1).length
  const s2wins = m.status === 'played' ? (m.score2 ?? 0) : sh.filter((s) => s.won === 2).length

  const inner = (
    <div className="ml-nested">
      <div className="ml-nested-head">
        <span className="ml-nested-side">
          <span className="dot" style={{ background: e1?.color ?? 'var(--border-control)' }} />
          <span className={`ml-nested-name${m.status === 'played' && m.winner_id === e1?.id ? ' ml-nested-won' : m.status === 'played' && m.winner_id ? ' ml-nested-lost' : ''}`}>
            {e1?.name ?? m.wait1 ?? 'TBD'}
          </span>
          <span className="ml-nested-pts num">{s1wins}</span>
        </span>
        <span className="ml-nested-sep">–</span>
        <span className="ml-nested-side ml-nested-side2">
          <span className="ml-nested-pts num">{s2wins}</span>
          <span className={`ml-nested-name${m.status === 'played' && m.winner_id === e2?.id ? ' ml-nested-won' : m.status === 'played' && m.winner_id ? ' ml-nested-lost' : ''}`}>
            {e2?.name ?? m.wait2 ?? 'TBD'}
          </span>
          <span className="dot" style={{ background: e2?.color ?? 'var(--border-control)' }} />
        </span>
      </div>
      {(sh.length > 0 || sr.length > 0) && (
        <div className="rp-series-breakdown ml-nested-breakdown">
          {sh.map((s, i) => {
            const winner = s.won === 1 ? e1 : e2
            return (
              <div key={i} className="ml-nested-series-item">
                <div className="rp-sb-row">
                  <span className="rp-sb-label">S{i + 1}</span>
                  <span className="rp-sb-winner" style={{ color: winner?.color }}>{winner?.name ?? `Side ${s.won}`}</span>
                  <span className="rp-sb-rounds">
                    {s.rounds.map((r, j) => (
                      <span key={j} title={r.map ?? undefined} className={`rp-sb-rd ${r.s1 > r.s2 ? 'w1' : 'w2'}`}>{r.s1}–{r.s2}</span>
                    ))}
                  </span>
                </div>
                <SeriesStats rounds={s.rounds} e1={e1} e2={e2} />
              </div>
            )
          })}
          {sr.length > 0 && (
            <div className="ml-nested-series-item">
              <div className="rp-sb-row current">
                <span className="rp-sb-label">S{sh.length + 1}</span>
                <span className="rp-sb-live">Live</span>
                <span className="rp-sb-rounds">
                  {sr.map((r, j) => (
                    <span key={j} title={r.map ?? undefined} className={`rp-sb-rd ${r.s1 > r.s2 ? 'w1' : 'w2'}`}>{r.s1}–{r.s2}</span>
                  ))}
                </span>
              </div>
              <SeriesStats rounds={sr} e1={e1} e2={e2} />
            </div>
          )}
        </div>
      )}
      <div className="ml-nested-meta">
        <span className="meta">{m.code}</span>
        {m.source?.startsWith('screenshot') && <span className="meta"><Icon name="cam" className="btn-ico" />AI</span>}
        {m.playable && <span className="ml-nested-cta">{sr.length > 0 ? 'Next round' : sh.length > 0 ? 'Next series' : 'Start'}</span>}
      </div>
    </div>
  )

  const cls = `ml-nested-wrap glass${m.playable ? ' ml-nested-ready' : ''}`
  return open
    ? <button type="button" className={cls} onClick={() => onPick(m)}>{inner}</button>
    : <div className={cls}>{inner}</div>
}

function Lineup({ t }: { t: Tournament }) {
  return (
    <ul className="tn-lineup">
      {t.entrants.map((e) => (
        <li key={e.id} className="glass tn-entrant">
          <span className="tn-entrant-name"><span className="dot dot-lg" style={{ background: e.color }} />{e.name}
            {e.group_label && <span className="pill">Group {e.group_label}</span>}<span className="meta">Seed {e.seed}</span></span>
          <ul className="tn-members">{e.members.map((m) => (
            <li key={m.id}><Icon name="user" className="btn-ico" />{m.display_name}{m.psn_id && <span className="meta"> · {m.psn_id}</span>}{m.is_guest && <span className="meta"> · guest</span>}</li>
          ))}</ul>
        </li>
      ))}
    </ul>
  )
}

function Shots({ t, shots, onOpen }: { t: Tournament; shots: Shot[]; onOpen: (s: Shot) => void }) {
  const qc = useQueryClient()
  const pending = shots.filter((s) => s.status === 'pending' || s.status === 'reading')
  return (
    <div className="tn-list">
      <p className="dim">Share a result screenshot in the squad's PSN group while this is live. The AI reads it and scores the match on its own when it's sure who played; anything it isn't sure about waits here for a tap.</p>
      {!pending.length && <p className="meta">Nothing waiting.</p>}
      <ul className="sh-list">
        {pending.map((s) => (
          <li key={s.id} className="sh glass">
            <img className="sh-img" src={`/api/tourney/shots/${s.id}/image`} alt="Score screenshot" loading="lazy" />
            <div className="sh-body">
              <span className="meta">From {s.sender || 'PSN'} · {new Date(s.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
              {s.status === 'reading' ? <span>Reading…</span> : (
                <span>{s.reading?.kind === 'h2h' ? (s.reading.sides ?? []).map((x) => `${x.label ?? '?'} ${x.score ?? '?'}`).join(' – ')
                  : s.reading?.kind === 'scoreboard' ? `${s.reading.rows?.length ?? 0} players on the scoreboard` : 'No score found'}</span>
              )}
              {s.suggestion?.found && <span className="meta">Looks like {s.suggestion.label}{s.suggestion.tournament_id !== t.id ? ' (another tournament)' : ''}</span>}
              {s.note && <span className="meta">{s.note}</span>}
              <div className="sh-acts">
                <button type="button" className="btn btn-secondary" disabled={s.status === 'reading'} onClick={() => onOpen(s)}>Check and save</button>
                <button type="button" className="btn btn-ghost" onClick={() => void api.dismissShot(s.id).then(() => qc.invalidateQueries({ queryKey: ['tourney', 'shots'] }))}>Dismiss</button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ShotApply({ t, shot, m, l, onClose }: { t: Tournament; shot: Shot; m?: Match; l?: Lobby; onClose: () => void }) {
  const [target, setTarget] = useState<string>(m?.id ?? l?.id ?? '')
  const match = t.matches.find((x) => x.id === target)
  const lobby = t.lobbies.find((x) => x.id === target)
  const ents = new Map(t.entrants.map((e) => [e.id, e]))
  const options = t.kind === 'ffa'
    ? t.lobbies.map((x) => ({ id: x.id, label: `Game ${x.num}${x.status === 'played' ? ' (played)' : ''}` }))
    : t.matches.filter((x) => x.playable || x.status === 'played').map((x) => ({ id: x.id, label: `${x.code}: ${ents.get(x.e1 ?? '')?.name} vs ${ents.get(x.e2 ?? '')?.name}${x.status === 'played' ? ' (played)' : ''}` }))
  const sug = shot.suggestion
  return (
    <div className="rp">
      <img className="sh-big" src={`/api/tourney/shots/${shot.id}/image`} alt="Score screenshot" />
      <label className="tn-field"><span className="field-label">Which {t.kind === 'ffa' ? 'game' : 'match'} is this?</span>
        <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Choose…</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </label>
      {match && <ReportMatch key={match.id} t={t} m={match} shotId={shot.id}
        prefill={sug?.target_id === match.id && sug.games ? { games: sug.games, pens: sug.pens } : undefined} onClose={onClose} />}
      {lobby && <ReportLobby key={lobby.id} t={t} lobby={lobby} shotId={shot.id}
        prefill={sug?.target_id === lobby.id ? sug.rows : undefined} onClose={onClose} />}
    </div>
  )
}
