import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { CACHE } from '@/app/queryClient'
import { to } from '@/app/routes'
import { getHype, getSquad } from '@/lib/api/squad'
import type { SquadMember } from '@/lib/api/squad'
import { Badge, Card, SectionHeading, StatusDot, cx } from '@/components/ui'
import {
  EmptyState,
  Freshness,
  RelativeTime,
  SectionError,
  SkeletonRows,
  SkeletonTiles,
  StaleNotice,
} from '@/components/ui/states'
import { PageTitle } from '@/components/PageTitle'

/**
 * Home: who is online, what they are playing, and how to join them.
 *
 * The legacy Squad tab opened with the hype meter and three aggregate tiles, then the
 * member list, then ranks and trophies. That is the wrong order for the question this
 * screen exists to answer — "is anyone on?" — so presence is first and the aggregates
 * moved below it. Trophies stay, because they are part of why people look, but they are
 * a column on a row rather than the headline.
 *
 * Each section reads independently: hype failing must not take presence with it.
 */
export function HomePage() {
  const squad = useQuery({
    queryKey: ['squad'],
    queryFn: ({ signal }) => getSquad(signal),
    ...CACHE.presence,
  })
  const hype = useQuery({
    queryKey: ['hype'],
    queryFn: ({ signal }) => getHype(signal),
    ...CACHE.hype,
  })

  const members = squad.data?.members ?? []
  const online = members.filter(m => m.online)
  // A refresh that failed while we still have usable data on screen. Labelled, not
  // blanked.
  const squadStale = squad.isError && Boolean(squad.data)

  return (
    <div className="mx-auto w-full max-w-[var(--content-width)]">
      <PageTitle
        title="Squad"
        subtitle={
          squad.data
            ? online.length > 0
              ? `${online.length} of ${members.length} online right now`
              : 'Nobody online right now'
            : undefined
        }
        meta={<Freshness at={squad.dataUpdatedAt || null} stale={squadStale} />}
      />

      {squadStale && <div className="mb-4"><StaleNotice onRetry={() => void squad.refetch()} /></div>}

      {/* ── Who is on ─────────────────────────────────────────────────────── */}
      <section aria-labelledby="who-is-on" className="mb-8">
        <SectionHeading level={2}>
          <span id="who-is-on">Who&rsquo;s on</span>
        </SectionHeading>

        {squad.isPending && !squad.data ? (
          // 7 rows at the real row height: the squad is seven people, and a member row is
          // two lines of text plus a 44px avatar inside py-3, which measures ~72px.
          <SkeletonRows rows={7} height={72} />
        ) : squad.isError && !squad.data ? (
          <SectionError error={squad.error} what="the squad" onRetry={() => void squad.refetch()} />
        ) : squad.data?.error ? (
          // The backend answered, but PSN did not. That is a different message from
          // "the request failed", and pretending otherwise sends people to check their
          // own connection.
          <Card>
            <EmptyState
              title="PlayStation is not answering"
              body={`Presence is unavailable right now, so this list may be out of date. (${squad.data.error})`}
            />
          </Card>
        ) : members.length === 0 ? (
          <Card>
            <EmptyState
              title="Nobody has linked an account yet"
              body="Link your PlayStation account and you will show up here with whatever you are playing."
              action={
                <a
                  href="/portal"
                  className="text-sm font-semibold text-[var(--color-accent-text)] hover:underline"
                >
                  Link your account →
                </a>
              }
            />
          </Card>
        ) : (
          <ul className="flex flex-col gap-2">
            {members.map(m => (
              <MemberRow key={m.onlineId} member={m} />
            ))}
          </ul>
        )}
      </section>

      {/* ── Today ─────────────────────────────────────────────────────────── */}
      <section aria-labelledby="today" className="mb-8">
        <SectionHeading level={2} hint="across the group chat">
          <span id="today">Today</span>
        </SectionHeading>
        {hype.isPending && !hype.data ? (
          <SkeletonTiles count={3} />
        ) : hype.isError && !hype.data ? (
          <SectionError error={hype.error} what="today's activity" onRetry={() => void hype.refetch()} />
        ) : (
          <HypeCard
            label={hype.data?.label ?? ''}
            pct={hype.data?.pct ?? 0}
            count={hype.data?.count ?? 0}
          />
        )}
      </section>

      {/* ── Standing ──────────────────────────────────────────────────────── */}
      {members.length > 0 && (
        <section aria-labelledby="standing" className="mb-8">
          <SectionHeading
            level={2}
            action={
              <Link
                to={to('clips')}
                className="text-sm font-semibold text-[var(--color-accent-text)] hover:underline"
              >
                Clips &amp; montages →
              </Link>
            }
          >
            <span id="standing">Standing</span>
          </SectionHeading>
          <StatTiles members={members} />
        </section>
      )}
    </div>
  )
}

function MemberRow({ member }: { member: SquadMember }) {
  return (
    <Card as="li" className="flex items-center gap-3 px-3.5 py-3">
      <Avatar member={member} />

      {/* Two fixed lines, and the name truncates rather than wrapping. Letting this row
          wrap made every row a different height on a 390px screen — "themoosecompany"
          pushed its Online badge onto a third line while "moiz" stayed on one. */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <StatusDot live={member.online} />
          <span className="min-w-0 truncate text-base font-bold">
            {member.onlineId}
          </span>
          {/* The dot is decorative; this is the text that actually says it. */}
          {member.online && (
            <Badge tone="live" className="shrink-0">
              Online
            </Badge>
          )}
        </div>
        <p className="truncate text-sm text-[var(--color-fg-muted)]">
          {member.game ?? (member.online ? 'In the menus' : 'No recent game')}
          {member.platform && (
            <span className="text-[var(--color-fg-subtle)]"> · {member.platform}</span>
          )}
          {!member.online && (
            <span className="text-[var(--color-fg-subtle)]">
              {' · '}
              {member.lastSeen ? <>last on <RelativeTime at={member.lastSeen} /></> : 'offline'}
            </span>
          )}
        </p>
      </div>

      {/* Trophies: level is the headline, plat/gold are the supporting detail beneath it,
          and the whole block is one column so it lines up down the list. The previous
          arrangement put them side by side and read as three unrelated numbers. */}
      {member.trophyLevel !== null && (
        <div className="shrink-0 text-right">
          <p className="numeral text-lg leading-none text-[var(--color-warn-text)]">
            {member.trophyLevel}
            <span className="ml-1 text-2xs font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">
              lvl
            </span>
          </p>
          <p className="mt-1 hidden text-xs text-[var(--color-fg-subtle)] sm:block">
            <span className="numeral text-[var(--color-fg-muted)]">{member.platinum}</span> plat ·{' '}
            <span className="numeral text-[var(--color-fg-muted)]">{member.gold}</span> gold
          </p>
        </div>
      )}
    </Card>
  )
}

/**
 * Avatars come from PSN and frequently 404 or are simply absent. The initial is the
 * default rather than the fallback, and the image is layered over it — so a broken
 * image leaves a readable monogram instead of a torn-page icon, and the box is always
 * the same size, which is what keeps the row from shifting when the image lands.
 */
function Avatar({ member }: { member: SquadMember }) {
  return (
    <div
      className={cx(
        'relative grid size-11 shrink-0 place-items-center overflow-hidden',
        'rounded-[var(--radius-md)] bg-[var(--color-surface-3)]',
        'text-base font-bold text-[var(--color-fg-muted)]',
      )}
    >
      <span aria-hidden="true">{member.onlineId.slice(0, 1).toUpperCase()}</span>
      {member.avatar && (
        <img
          src={member.avatar}
          alt=""
          width={44}
          height={44}
          loading="lazy"
          decoding="async"
          className="absolute inset-0 size-full object-cover"
          onError={e => {
            e.currentTarget.style.display = 'none'
          }}
        />
      )}
    </div>
  )
}

function HypeCard({ label, pct, count }: { label: string; pct: number; count: number }) {
  return (
    <Card className="px-4 py-3.5">
      <div className="mb-2.5 flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-2xs uppercase tracking-wider text-[var(--color-fg-subtle)]">
            Chat activity
          </p>
          <p className="text-lg font-bold">{label}</p>
        </div>
        <p className="numeral text-xl text-[var(--color-accent-text)]">
          {count}
          <span className="ml-1.5 text-sm font-semibold text-[var(--color-fg-subtle)]">
            messages
          </span>
        </p>
      </div>
      <div
        role="meter"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="How busy the group chat is today"
        className="h-2 overflow-hidden rounded-[var(--radius-full)] bg-[var(--color-surface-3)]"
      >
        <div
          className="h-full rounded-[var(--radius-full)] bg-[var(--color-accent)] transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out)]"
          style={{ width: `${pct}%` }}
        />
      </div>
    </Card>
  )
}

function StatTiles({ members }: { members: SquadMember[] }) {
  const platinum = members.reduce((n, m) => n + m.platinum, 0)
  const levels = members.map(m => m.trophyLevel).filter((n): n is number => n !== null)
  const topLevel = levels.length > 0 ? Math.max(...levels) : null
  const games = new Map<string, number>()
  for (const m of members) if (m.game) games.set(m.game, (games.get(m.game) ?? 0) + 1)
  const favourite = [...games.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

  return (
    <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]">
      <Tile label="Platinums" value={String(platinum)} />
      <Tile label="Top level" value={topLevel === null ? '—' : String(topLevel)} />
      <Tile label="Squad favourite" value={favourite ?? '—'} small={favourite !== null} />
    </div>
  )
}

function Tile({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <Card className="px-4 py-3.5 text-center">
      <p
        className={cx(
          'numeral truncate',
          small ? 'text-base' : 'text-2xl',
        )}
        title={small ? value : undefined}
      >
        {value}
      </p>
      <p className="mt-0.5 text-2xs uppercase tracking-wider text-[var(--color-fg-subtle)]">
        {label}
      </p>
    </Card>
  )
}
