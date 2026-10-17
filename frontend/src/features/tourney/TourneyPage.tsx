import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTitle } from '../../app/title'
import { ErrorStrip } from '../../components/states'
import { Icon } from '../../components/Icon'
import {
  listTournaments, getTournament, createTournament, generateBracket,
  recordResult, addTeam, removeTeam,
  listPlayers, addPlayer, addRosterPlayer, removeRosterPlayer,
  FORMAT_LABELS, GAMES,
  type Tournament, type Match, type Team, type Player,
} from '../../lib/tourney'

const TEAM_COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#8b5cf6', '#14b8a6']

// ── Main Page ──────────────────────────────────────────────────────────────────
export function TourneyPage() {
  useTitle('Tourney')
  const [view, setView] = useState<'list' | 'create' | { id: string }>('list')

  if (view === 'create') return <CreateTournament onDone={(id) => setView({ id })} onBack={() => setView('list')} />
  if (typeof view === 'object') return <TournamentDetail id={view.id} onBack={() => setView('list')} />
  return <TournamentList onSelect={(id) => setView({ id })} onCreate={() => setView('create')} />
}

// ── Tournament List ────────────────────────────────────────────────────────────
function TournamentList({ onSelect, onCreate }: { onSelect: (id: string) => void; onCreate: () => void }) {
  const q = useQuery({
    queryKey: ['tourney', 'list'],
    queryFn: ({ signal }) => listTournaments(undefined, signal),
    refetchInterval: 30_000,
  })
  const tournaments = q.data ?? []

  return (
    <div className="page">
      <div className="page-head-row">
        <h1 className="page-h1" tabIndex={-1}>Tourney</h1>
        <button className="btn-pill" onClick={onCreate}>+ New</button>
      </div>
      {q.isError && <ErrorStrip text="Couldn't load tournaments" onRetry={() => q.refetch()} />}
      {q.isLoading && <div className="skeleton" style={{ height: 80, borderRadius: 12 }} />}
      {!q.isLoading && tournaments.length === 0 && (
        <div className="empty-state">
          <Icon name="tourney" className="empty-icon" />
          <p>No tournaments yet.<br />Create one to get started.</p>
        </div>
      )}
      <div className="tourney-list">
        {tournaments.map((t) => (
          <button key={t.id} className="tourney-card glass" onClick={() => onSelect(t.id)}>
            <div className="tourney-card-head">
              <span className="tourney-game-chip">{t.game}</span>
              <span className={`tourney-status ${t.status}`}>{t.status}</span>
            </div>
            <div className="tourney-card-name">{t.name}</div>
            <div className="tourney-card-meta">{FORMAT_LABELS[t.format]} · {t.team_count} teams</div>
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Create Tournament ──────────────────────────────────────────────────────────
function CreateTournament({ onDone, onBack }: { onDone: (id: string) => void; onBack: () => void }) {
  const [name, setName] = useState('')
  const [game, setGame] = useState(GAMES[0]!)
  const [customGame, setCustomGame] = useState('')
  const [format, setFormat] = useState<string>('single_elim')
  const [err, setErr] = useState('')
  const qc = useQueryClient()
  const mut = useMutation({
    mutationFn: () =>
      createTournament({ name: name.trim(), game: game === 'Other' ? customGame.trim() : game, format }),
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ['tourney', 'list'] })
      onDone(t.id)
    },
    onError: (e: Error) => setErr(e.message),
  })

  return (
    <div className="page">
      <button className="back-btn" onClick={onBack}><Icon name="left" /> Tournaments</button>
      <h1 className="page-h1" tabIndex={-1}>New Tournament</h1>
      <div className="form-stack glass" style={{ maxWidth: 480, padding: 24, borderRadius: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <label className="form-label">
          Name
          <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. CRCMZ FIFA Cup" />
        </label>
        <label className="form-label">
          Game
          <select className="form-input" value={game} onChange={(e) => setGame(e.target.value)}>
            {GAMES.map((g) => <option key={g}>{g}</option>)}
          </select>
        </label>
        {game === 'Other' && (
          <label className="form-label">
            Game name
            <input className="form-input" value={customGame} onChange={(e) => setCustomGame(e.target.value)} placeholder="e.g. Tekken 8" />
          </label>
        )}
        <label className="form-label">
          Format
          <div className="seg-row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            {(Object.entries(FORMAT_LABELS) as [string, string][]).map(([k, v]) => (
              <button key={k} type="button" className={`seg-btn${format === k ? ' on' : ''}`} onClick={() => setFormat(k)}>{v}</button>
            ))}
          </div>
        </label>
        {err && <p className="form-err">{err}</p>}
        <button className="btn-primary" disabled={!name.trim() || mut.isPending} onClick={() => mut.mutate()}>
          {mut.isPending ? 'Creating…' : 'Create Tournament'}
        </button>
      </div>
    </div>
  )
}

// ── Tournament Detail ──────────────────────────────────────────────────────────
function TournamentDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [tab, setTab] = useState<'bracket' | 'teams' | 'players'>('bracket')
  const q = useQuery({
    queryKey: ['tourney', id],
    queryFn: ({ signal }) => getTournament(id, signal),
    refetchInterval: 15_000,
  })
  const t = q.data

  return (
    <div className="page">
      <button className="back-btn" onClick={onBack}><Icon name="left" /> Tournaments</button>
      {!t && q.isLoading && <div className="skeleton" style={{ height: 200, borderRadius: 12, marginTop: 16 }} />}
      {q.isError && <ErrorStrip text="Couldn't load tournament" onRetry={() => q.refetch()} />}
      {t && (
        <>
          <div className="tourney-detail-head">
            <h1 className="page-h1" tabIndex={-1}>{t.name}</h1>
            <div className="tourney-detail-meta" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
              <span className="tourney-game-chip">{t.game}</span>
              <span className={`tourney-status ${t.status}`}>{t.status}</span>
              <span style={{ opacity: 0.6, fontSize: 14 }}>{FORMAT_LABELS[t.format]}</span>
            </div>
          </div>
          <div className="tab-row" style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
            {(['bracket', 'teams', 'players'] as const).map((tb) => (
              <button key={tb} className={`tab-btn${tab === tb ? ' on' : ''}`} onClick={() => setTab(tb)}>
                {tb.charAt(0).toUpperCase() + tb.slice(1)}
              </button>
            ))}
          </div>
          {tab === 'bracket' && <BracketTab t={t} />}
          {tab === 'teams' && <TeamsTab t={t} />}
          {tab === 'players' && <PlayersTab />}
        </>
      )}
    </div>
  )
}

// ── Bracket Tab ────────────────────────────────────────────────────────────────
function BracketTab({ t }: { t: Tournament }) {
  const qc = useQueryClient()
  const genMut = useMutation({
    mutationFn: () => generateBracket(t.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tourney', t.id] }),
  })
  const [scoring, setScoring] = useState<string | null>(null)

  const rounds = t.rounds ?? []
  const hasTeams = (t.teams?.length ?? 0) >= 2

  if (rounds.length === 0) {
    return (
      <div className="bracket-empty glass" style={{ padding: 24, borderRadius: 12, textAlign: 'center' }}>
        {!hasTeams ? (
          <p>Add at least 2 teams in the <strong>Teams</strong> tab, then generate the bracket.</p>
        ) : (
          <button className="btn-primary" disabled={genMut.isPending} onClick={() => genMut.mutate()}>
            {genMut.isPending ? 'Generating…' : `Generate Bracket (${t.teams?.length} teams)`}
          </button>
        )}
      </div>
    )
  }

  const allMatches = rounds.flatMap((r) => r.matches)

  return (
    <div className="bracket-wrap">
      <div className="bracket-scroll" style={{ display: 'flex', gap: 24, overflowX: 'auto', paddingBottom: 16 }}>
        {rounds.map((r) => (
          <div key={r.round} className="bracket-round" style={{ minWidth: 200 }}>
            <div className="bracket-round-label" style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', opacity: 0.5, marginBottom: 8 }}>
              {r.round === rounds.length ? 'Final' : r.round === rounds.length - 1 ? 'Semi-Final' : `Round ${r.round}`}
            </div>
            <div className="bracket-matches" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {r.matches.map((m) => (
                <MatchCard key={m.id} match={m} onScore={() => setScoring(m.id)} />
              ))}
            </div>
          </div>
        ))}
      </div>
      {scoring && (
        <ScoreModal
          match={allMatches.find((m) => m.id === scoring)!}
          onClose={() => setScoring(null)}
          onSaved={() => { setScoring(null); qc.invalidateQueries({ queryKey: ['tourney', t.id] }) }}
        />
      )}
    </div>
  )
}

function MatchCard({ match: m, onScore }: { match: Match; onScore: () => void }) {
  const isDone = m.status === 'played' || m.status === 'bye'
  const isClickable = m.status === 'pending' && m.team1_id && m.team2_id

  return (
    <div
      className={`match-card glass${isDone ? ' done' : ''}${isClickable ? ' clickable' : ''}`}
      onClick={isClickable ? onScore : undefined}
      style={{ padding: '10px 12px', borderRadius: 10, cursor: isClickable ? 'pointer' : 'default', display: 'flex', flexDirection: 'column', gap: 4 }}
    >
      <TeamSlot team={m.team1} score={m.score1} isWinner={m.winner_id === m.team1_id && isDone} />
      <div style={{ fontSize: 11, textAlign: 'center', opacity: 0.4 }}>vs</div>
      <TeamSlot team={m.team2} score={m.score2} isWinner={m.winner_id === m.team2_id && isDone} />
      {isClickable && (
        <div style={{ fontSize: 11, textAlign: 'center', opacity: 0.5, marginTop: 4 }}>Tap to enter score</div>
      )}
    </div>
  )
}

function TeamSlot({ team, score, isWinner }: { team?: Team | null; score: number | null; isWinner: boolean }) {
  if (!team) return <div style={{ fontSize: 13, opacity: 0.35, padding: '2px 0' }}>TBD</div>
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: isWinner ? 700 : 400 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: team.color, flexShrink: 0 }} />
      <span style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{team.name}</span>
      {score !== null && <span style={{ fontSize: 14, fontWeight: 700, color: isWinner ? 'var(--amber2, #f0a500)' : undefined }}>{score}</span>}
    </div>
  )
}

function ScoreModal({ match: m, onClose, onSaved }: { match: Match; onClose: () => void; onSaved: () => void }) {
  const [s1, setS1] = useState('')
  const [s2, setS2] = useState('')
  const [err, setErr] = useState('')
  const mut = useMutation({
    mutationFn: () => recordResult(m.id, parseInt(s1), parseInt(s2)),
    onSuccess: onSaved,
    onError: (e: Error) => setErr(e.message),
  })

  return (
    <div className="modal-backdrop" onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="modal-box glass" onClick={(e) => e.stopPropagation()} style={{ padding: 24, borderRadius: 16, minWidth: 280, maxWidth: '90vw' }}>
        <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>Enter Score</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: m.team1?.color }} />
              {m.team1?.name}
            </div>
            <input className="form-input" type="number" min="0" value={s1} onChange={(e) => setS1(e.target.value)} placeholder="0" style={{ textAlign: 'center', width: 60 }} />
          </div>
          <span style={{ opacity: 0.4 }}>—</span>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: m.team2?.color }} />
              {m.team2?.name}
            </div>
            <input className="form-input" type="number" min="0" value={s2} onChange={(e) => setS2(e.target.value)} placeholder="0" style={{ textAlign: 'center', width: 60 }} />
          </div>
        </div>
        {err && <p className="form-err" style={{ marginTop: 12 }}>{err}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!s1 || !s2 || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? 'Saving…' : 'Save Result'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Teams Tab ──────────────────────────────────────────────────────────────────
function TeamsTab({ t }: { t: Tournament }) {
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [colorIdx, setColorIdx] = useState(0)
  const qc = useQueryClient()
  const addMut = useMutation({
    mutationFn: () => addTeam(t.id, { name: newName, color: TEAM_COLORS[colorIdx] }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tourney', t.id] }); setNewName(''); setAdding(false) },
  })
  const removeMut = useMutation({
    mutationFn: (teamId: string) => removeTeam(t.id, teamId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tourney', t.id] }),
  })

  return (
    <div className="teams-tab" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {(t.teams ?? []).map((team) => (
        <TeamCard key={team.id} team={team} tournamentId={t.id} onRemove={() => removeMut.mutate(team.id)} />
      ))}
      {adding ? (
        <div className="glass add-team-form" style={{ padding: 16, borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input className="form-input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Team name" autoFocus />
          <div className="color-row" style={{ display: 'flex', gap: 8 }}>
            {TEAM_COLORS.map((c, i) => (
              <button
                key={c}
                type="button"
                onClick={() => setColorIdx(i)}
                aria-label={`Color ${c}`}
                style={{
                  width: 22, height: 22, borderRadius: '50%', background: c, border: colorIdx === i ? '2px solid white' : '2px solid transparent', cursor: 'pointer',
                }}
              />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn-ghost" onClick={() => setAdding(false)}>Cancel</button>
            <button className="btn-primary" disabled={!newName.trim() || addMut.isPending} onClick={() => addMut.mutate()}>
              {addMut.isPending ? '…' : 'Add Team'}
            </button>
          </div>
        </div>
      ) : (
        <button className="btn-ghost" onClick={() => setAdding(true)} style={{ alignSelf: 'flex-start' }}>+ Add Team</button>
      )}
    </div>
  )
}

function TeamCard({ team, tournamentId, onRemove }: { team: Team; tournamentId: string; onRemove: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const qc = useQueryClient()
  const playersQ = useQuery({ queryKey: ['tourney', 'players'], queryFn: ({ signal }) => listPlayers(signal) })
  const addMut = useMutation({
    mutationFn: (playerId: string) => addRosterPlayer(team.id, playerId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tourney', tournamentId] }),
  })
  const removeMut = useMutation({
    mutationFn: (playerId: string) => removeRosterPlayer(team.id, playerId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tourney', tournamentId] }),
  })
  const roster = team.players ?? []
  const rosterIds = new Set(roster.map((p) => p.id))
  const available = (playersQ.data ?? []).filter((p) => !rosterIds.has(p.id))

  return (
    <div className="team-card glass" style={{ borderRadius: 12, overflow: 'hidden' }}>
      <div
        className="team-card-head"
        onClick={() => setExpanded(!expanded)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', cursor: 'pointer' }}
      >
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: team.color, flexShrink: 0 }} />
        <span style={{ flex: 1, fontWeight: 600 }}>{team.name}</span>
        <span style={{ opacity: 0.5, fontSize: 13 }}>{roster.length} players</span>
        <Icon name={expanded ? 'up' : 'down'} />
      </div>
      {expanded && (
        <div className="team-card-body" style={{ padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {roster.map((p) => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon name="user" />
              <span style={{ flex: 1, fontSize: 14 }}>{p.display_name}</span>
              <button className="icon-btn" onClick={() => removeMut.mutate(p.id)}><Icon name="close" /></button>
            </div>
          ))}
          {available.length > 0 && (
            <select className="form-input" onChange={(e) => { if (e.target.value) addMut.mutate(e.target.value) }} value="">
              <option value="">Add player…</option>
              {available.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
            </select>
          )}
          <button
            style={{ fontSize: 13, color: 'var(--danger, #f87171)', background: 'none', border: 'none', cursor: 'pointer', alignSelf: 'flex-start', padding: 0, marginTop: 4 }}
            onClick={onRemove}
          >
            Remove team
          </button>
        </div>
      )}
    </div>
  )
}

// ── Players Tab ────────────────────────────────────────────────────────────────
function PlayersTab() {
  const [newName, setNewName] = useState('')
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['tourney', 'players'], queryFn: ({ signal }) => listPlayers(signal) })
  const addMut = useMutation({
    mutationFn: () => addPlayer({ display_name: newName.trim(), is_custom: true }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tourney', 'players'] }); setNewName('') },
  })

  return (
    <div className="players-tab" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ fontSize: 13, opacity: 0.6, margin: 0 }}>
        CRCMZ members appear here when added to teams. Add custom players (guests) below.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          className="form-input"
          style={{ flex: 1 }}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Guest player name"
          onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) addMut.mutate() }}
        />
        <button className="btn-primary" disabled={!newName.trim() || addMut.isPending} onClick={() => addMut.mutate()}>Add</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {(q.data ?? []).map((p: Player) => (
          <div key={p.id} className="glass" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 10 }}>
            <Icon name="user" />
            <span style={{ flex: 1, fontSize: 14 }}>{p.display_name}</span>
            {p.is_custom === 1 && (
              <span style={{ fontSize: 11, opacity: 0.5, padding: '2px 6px', border: '1px solid currentColor', borderRadius: 4 }}>guest</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
