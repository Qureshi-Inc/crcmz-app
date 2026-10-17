// Points tables (league, groups), the lobby-series leaderboard and fixture lists.
import type { Entrant, Lobby, Match, TableRow, Tournament } from '../../lib/tourney'
import { MatchCard } from './Bracket'

export function Standings({ t, rows, group, qualify = 0 }: { t: Tournament; rows: TableRow[]; group?: string; qualify?: number }) {
  const ents = new Map(t.entrants.map((e) => [e.id, e]))
  const unit = t.unit === 'Goals' ? 'G' : t.unit.slice(0, 1)
  return (
    <div className="tb glass">
      {group !== undefined && <div className="card-head"><h3 className="section-h2">{group ? `Group ${group}` : 'Table'}</h3>
        {qualify > 0 && <span className="meta">Top {qualify} go through</span>}</div>}
      <div className="tb-scroll">
        <table className="tb-table">
          <thead>
            <tr>
              <th scope="col" className="tb-pos">#</th><th scope="col" className="tb-name">{t.team_size > 1 ? 'Team' : 'Player'}</th>
              <th scope="col">P</th><th scope="col">W</th>{t.draws && <th scope="col">D</th>}<th scope="col">L</th>
              <th scope="col" title={`${t.unit} for and against`}>{unit}F</th><th scope="col">{unit}A</th>
              <th scope="col">+/-</th><th scope="col" className="tb-pts">Pts</th><th scope="col" className="tb-form">Form</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const e = ents.get(r.entrant_id)
              const q = qualify > 0 && r.pos <= qualify
              return (
                <tr key={r.entrant_id} className={q ? 'tb-q' : undefined}>
                  <td className="tb-pos num">{r.pos}</td>
                  <th scope="row" className="tb-name"><span className="dot" style={{ background: e?.color }} />{e?.name}{q && <span className="sr-only"> (qualifies)</span>}</th>
                  <td className="num">{r.p}</td><td className="num">{r.w}</td>{t.draws && <td className="num">{r.d}</td>}<td className="num">{r.l}</td>
                  <td className="num">{r.f}</td><td className="num">{r.a}</td>
                  <td className="num">{r.f - r.a > 0 ? `+${r.f - r.a}` : r.f - r.a}</td>
                  <td className="tb-pts num">{r.pts}</td>
                  <td className="tb-form">{r.form.map((f, i) => <span key={i} className={`form form-${f}`} title={{ W: 'Won', D: 'Drew', L: 'Lost' }[f]}>{f}</span>)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function Fixtures({ t, matches, onPick }: { t: Tournament; matches: Match[]; onPick: (m: Match) => void }) {
  const ents = new Map(t.entrants.map((e) => [e.id, e]))
  const days = [...new Set(matches.map((m) => m.round))].sort((a, b) => a - b)
  return (
    <div className="fx">
      {days.map((d) => (
        <div key={d} className="fx-day">
          <h4 className="eyebrow">Matchday {d}</h4>
          <div className="fx-grid">
            {matches.filter((m) => m.round === d).map((m) => <MatchCard key={m.id} m={m} ents={ents} t={t} onPick={onPick} />)}
          </div>
        </div>
      ))}
    </div>
  )
}

export function Leaderboard({ t, onLobby }: { t: Tournament; onLobby: (l: Lobby) => void }) {
  const ents = new Map<string, Entrant>(t.entrants.map((e) => [e.id, e]))
  const top = Math.max(1, ...t.leaderboard.map((r) => r.points))
  const s = t.settings
  return (
    <div className="lb glass">
      <div className="card-head">
        <h3 className="section-h2">Leaderboard</h3>
        <span className="meta">{s.placement_points.slice(0, 3).join(' / ')} pts for 1st–3rd{s.kill_points ? ` · ${s.kill_points} per kill` : ''}</span>
      </div>
      <ol className="lb-rows">
        {t.leaderboard.map((r) => {
          const e = ents.get(r.entrant_id)
          return (
            <li key={r.entrant_id} className={`lb-row${r.pos === 1 && r.points > 0 ? ' lb-lead' : ''}`}>
              <span className="lb-pos num">{r.pos}</span>
              <span className="lb-main">
                <span className="lb-name"><span className="dot" style={{ background: e?.color }} />{e?.name}</span>
                <span className="lb-bar" aria-hidden="true"><span style={{ width: `${(r.points / top) * 100}%`, background: e?.color }} /></span>
                <span className="lb-games">
                  {t.lobbies.map((l) => {
                    const g = r.games[String(l.num)]
                    return <span key={l.id} className={`lb-g${g?.placement === 1 ? ' win' : ''}`} title={`Game ${l.num}`}>
                      {g ? `#${g.placement ?? '–'}` : '·'}{g && t.unit === 'Kills' ? <small> {g.kills}k</small> : null}
                    </span>
                  })}
                </span>
              </span>
              <span className="lb-stats">
                <b className="num">{r.points}</b><span className="meta">pts</span>
                <span className="meta num">{r.kills} kills · {r.wins} {r.wins === 1 ? 'win' : 'wins'}{r.avg_place ? ` · avg #${r.avg_place}` : ''}</span>
              </span>
            </li>
          )
        })}
      </ol>
      <div className="lb-lobbies">
        {t.lobbies.map((l) => (
          <button key={l.id} type="button" className={`chip${l.status === 'played' ? '' : ' chip-ready'}`} onClick={() => onLobby(l)}
            aria-pressed={l.status === 'played'}>
            Game {l.num}{l.status === 'played' ? ' ✓' : ''}
          </button>
        ))}
      </div>
    </div>
  )
}
