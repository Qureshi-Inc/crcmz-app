// Player leaderboards across tournaments (by person, never team) and one player's record.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTitle } from '../../app/title'
import { Icon } from '../../components/Icon'
import { ErrorStrip, SkeletonRows } from '../../components/states'
import { useCatalog, useLeaders, usePlayerStats, type Board } from '../../lib/tourney'
import { Sheet } from './Report'
import '../../styles/tourney.css'

export function LeadersPage() {
  useTitle('Tourney leaderboards')
  return (
    <div className="page tn">
      <Link to="/tourney" className="btn btn-ghost tn-back"><Icon name="left" className="btn-ico" />Tourney</Link>
      <div>
        <h1 className="page-h1" tabIndex={-1}>Leaderboards</h1>
        <p className="dim tn-sub">Every tournament game, by player. Kills, deaths and score come from the result screenshots.</p>
      </div>
      <Leaders />
    </div>
  )
}

export function Leaders({ tournamentId = '', fixedGame = '' }: { tournamentId?: string; fixedGame?: string }) {
  const [game, setGame] = useState(fixedGame)
  const [who, setWho] = useState<{ id: string; name: string } | null>(null)
  const q = useLeaders(game, tournamentId)
  const cat = useCatalog()
  const games = q.data?.games ?? []
  return (
    <div className="ld">
      {!tournamentId && games.length > 1 && (
        <div className="tn-chips" role="group" aria-label="Game">
          <button type="button" className="chip" aria-pressed={!game} onClick={() => setGame('')}>All games</button>
          {games.map((g) => (
            <button key={g} type="button" className="chip" aria-pressed={game === g} onClick={() => setGame(g)}>{cat.data?.games[g]?.name ?? g}</button>
          ))}
        </div>
      )}
      {q.isError && <ErrorStrip text="Couldn't load leaderboards" onRetry={() => q.refetch()} />}
      {q.isLoading && <SkeletonRows n={3} height={160} />}
      {q.data && !q.data.boards.length && (
        <div className="empty glass">
          <p className="empty-title">No stats yet</p>
          <p className="dim">Play a tournament game. Every result counts, and result screenshots add kills, deaths and score per player.</p>
        </div>
      )}
      <div className="ld-grid">
        {(q.data?.boards ?? []).map((b) => <BoardCard key={b.key} b={b} min={q.data!.min_games} onPick={(id, name) => setWho({ id, name })} />)}
      </div>
      <Sheet open={Boolean(who)} onOpenChange={(v) => !v && setWho(null)} title={who?.name ?? ''}>
        {who && <PlayerCard id={who.id} />}
      </Sheet>
    </div>
  )
}

function BoardCard({ b, min, onPick }: { b: Board; min: number; onPick: (id: string, name: string) => void }) {
  const needsMin = ['kd', 'kills_per_game', 'win_rate', 'for_per_game', 'against_per_game'].includes(b.key)
  return (
    <section className="ld-card glass" aria-label={b.title}>
      <div className="card-head"><h2 className="section-h2">{b.title}</h2>{needsMin && <span className="meta">min {min} games</span>}</div>
      <ol className="ld-rows">
        {b.rows.map((r, i) => (
          <li key={r.player_id}>
            <button type="button" className={`ld-row${i === 0 ? ' ld-top' : ''}`} onClick={() => onPick(r.player_id, r.name)}>
              <span className="ld-pos num">{i + 1}</span>
              <span className="ld-name">{r.name}</span>
              <span className="ld-val num">{b.key === 'win_rate' ? `${r.value}%` : r.value}</span>
            </button>
          </li>
        ))}
      </ol>
      <p className="meta ld-unit">{b.unit}</p>
    </section>
  )
}

function PlayerCard({ id }: { id: string }) {
  const q = usePlayerStats(id)
  const p = q.data
  if (q.isError) return <ErrorStrip text="Couldn't load this player" onRetry={() => q.refetch()} />
  if (!p) return <SkeletonRows n={3} height={48} />
  const tiles: [string, string | number][] = [
    ['Titles', p.titles], ['Games', p.games + p.lobby_games], ['Wins', p.wins + p.lobby_wins], ['Win rate', `${p.win_rate}%`],
  ]
  if (p.kills || p.deaths) tiles.push(['Kills', p.kills], ['Deaths', p.deaths], ['K/D', p.kd], ['Best game', `${p.best_kills} kills`])
  if (p.score) tiles.push(['Score', p.score])
  if (p.assists) tiles.push(['Assists', p.assists])
  if (p.for) tiles.push(['Scored', p.for], ['Conceded', p.against])
  if (p.avg_place) tiles.push(['Avg place', `#${p.avg_place}`])
  for (const [k, v] of Object.entries(p.extra)) if (k !== 'possession') tiles.push([k.replace(/_/g, ' '), v])
  return (
    <div className="rp">
      <div className="pl-tiles">{tiles.map(([k, v]) => <div key={k} className="pl-tile"><span className="pl-v num">{v}</span><span className="meta">{k}</span></div>)}</div>
      {p.recent_games.length > 0 && (
        <>
          <h3 className="eyebrow">Recent games from screenshots</h3>
          <ul className="pl-recent">
            {p.recent_games.map((g, i) => (
              <li key={i}><span>{g.tournament} · game {g.game_no}</span>
                <span className="meta num">{[g.won === 1 ? 'W' : g.won === 0 ? 'L' : '', g.kills != null ? `${g.kills}K` : '', g.deaths != null ? `${g.deaths}D` : '', g.score != null ? `${g.score} pts` : '', g.placement ? `#${g.placement}` : ''].filter(Boolean).join(' · ')}</span></li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
