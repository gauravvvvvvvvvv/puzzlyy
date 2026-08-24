import Link from 'next/link';

import { ResumeCard } from '@/components/site/ResumeCard';
import { ButtonLink, Pill } from '@/components/ui/Button';
import { Icon, type IconName } from '@/components/ui/Icon';
import { PIECE_COUNT_BLURB } from '@/lib/format';
import { GAMES } from '@/lib/games';
import { PIECE_COUNTS } from '@/types/models';

export const metadata = {
  title: 'Puzzly — solve puzzles together',
  description:
    'Turn any picture into a jigsaw and solve it together in real time. No signup — just send your friend a link.',
};

/* -------------------------------------------------------------------------- */

const STEPS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'image',
    title: 'Pick a picture',
    body: 'Upload a photo of the two of you, or take one from our collection. Anything works.',
  },
  {
    icon: 'link',
    title: 'Send one link',
    body: 'We make a private room. Copy the link, drop it in your chat, and that is the whole invite.',
  },
  {
    icon: 'users',
    title: 'Solve it together',
    body: 'You both see the same board, the same pieces and each other’s cursor, live.',
  },
];

/** Decorative: a board mid-solve, drawn with nothing but boxes. */
function HeroBoard() {
  const placed = new Set([6, 7, 8, 11, 12, 13, 16, 17]);
  const tints = ['var(--color-player-1)', 'var(--color-player-2)', 'var(--color-player-3)'];

  return (
    <div aria-hidden="true" className="relative select-none">
      <div
        className="card overflow-hidden p-3 shadow-[var(--shadow-lift)] sm:p-4"
        style={{ background: 'var(--board-bg)' }}
      >
        <div className="grid grid-cols-5 gap-1.5">
          {Array.from({ length: 20 }, (_, index) => {
            const isPlaced = placed.has(index);
            return (
              <div
                key={index}
                className="aspect-square rounded-[7px]"
                style={
                  isPlaced
                    ? {
                        background: `color-mix(in oklab, ${tints[index % 3]} 62%, var(--board-bg))`,
                        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.22)',
                      }
                    : { background: 'var(--board-slot)' }
                }
              />
            );
          })}
        </div>
      </div>

      {/* Two loose pieces waiting to be dragged in. */}
      <div
        className="absolute -top-5 -right-4 size-14 rotate-12 rounded-[10px] border border-[var(--line-strong)] shadow-[var(--shadow-soft)] sm:size-16"
        style={{ background: 'color-mix(in oklab, var(--color-player-4) 68%, var(--surface))' }}
      />
      <div
        className="absolute -bottom-6 -left-5 size-12 -rotate-[9deg] rounded-[10px] border border-[var(--line-strong)] shadow-[var(--shadow-soft)] sm:size-14"
        style={{ background: 'color-mix(in oklab, var(--color-player-5) 68%, var(--surface))' }}
      />

      {/* Live cursors, the thing that makes it feel like a room. */}
      <CursorTag name="You" color="var(--color-player-1)" className="top-[34%] left-[26%]" />
      <CursorTag name="Sam" color="var(--color-player-2)" className="top-[62%] left-[58%]" />
    </div>
  );
}

function CursorTag({
  name,
  color,
  className = '',
}: {
  name: string;
  color: string;
  className?: string;
}) {
  return (
    <div className={`pointer-events-none absolute ${className}`}>
      <svg width="18" height="18" viewBox="0 0 18 18" className="drop-shadow-sm">
        <path d="M2 1.5 15 8.2 9.4 9.6 7.6 15.4Z" fill={color} stroke="white" strokeWidth="1.1" />
      </svg>
      <span
        className="absolute top-4 left-3.5 rounded-full px-2 py-0.5 text-[0.625rem] font-semibold whitespace-nowrap text-white"
        style={{ background: color }}
      >
        {name}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export default function LandingPage() {
  return (
    <>
      {/* ---------------------------------------------------------------- Hero */}
      <section className="mx-auto w-full max-w-6xl px-4 pt-14 pb-6 sm:px-6 sm:pt-20">
        <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
          <div className="animate-rise">
            <p className="eyebrow mb-5 flex items-center gap-2">
              <span className="inline-block size-1.5 rounded-full bg-[var(--color-mint-400)]" />
              Real-time · two players · no signup
            </p>

            <h1 className="text-[clamp(2.4rem,6.2vw,3.9rem)] leading-[1.03]">
              Turn any picture into a puzzle.
            </h1>
            <p className="mt-5 max-w-lg text-lg text-[var(--fg-muted)] sm:text-xl">
              Solve it together with your favorite person.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3">
              <ButtonLink href="/play" variant="primary" size="lg">
                <Icon name="users" size={19} />
                Play with a friend
              </ButtonLink>
              <ButtonLink href="/join" size="lg">
                <Icon name="key" size={18} />
                I have a room code
              </ButtonLink>
            </div>

            <p className="mt-4 text-sm text-[var(--fg-subtle)]">
              Or{' '}
              <Link href="/play?solo=1" className="underline decoration-dotted hover:text-[var(--fg)]">
                play on your own
              </Link>{' '}
              — same board, no waiting.
            </p>

            <div className="mt-8 max-w-md">
              <ResumeCard />
            </div>
          </div>

          <div className="mx-auto w-full max-w-sm lg:max-w-none">
            <HeroBoard />
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- How it works */}
      <section className="mx-auto w-full max-w-6xl px-4 pt-20 sm:px-6">
        <h2 className="text-2xl sm:text-3xl">Three steps, then you&rsquo;re playing</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {STEPS.map((step, index) => (
            <div key={step.title} className="card p-5">
              <div className="flex items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
                  <Icon name={step.icon} size={20} />
                </span>
                <span className="num text-2xs text-[var(--fg-subtle)]">0{index + 1}</span>
              </div>
              <h3 className="mt-4 text-lg">{step.title}</h3>
              <p
                className="mt-1.5 text-sm text-[var(--fg-muted)]"
              >
                {step.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* --------------------------------------------------------- Piece counts */}
      <section className="mx-auto w-full max-w-6xl px-4 pt-20 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-2xl sm:text-3xl">Pick how long you&rsquo;ve got</h2>
          <p className="text-sm text-[var(--fg-muted)]">Rotation and blind mode make any of them meaner.</p>
        </div>
        <ul className="mt-8 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {PIECE_COUNTS.map((count) => (
            <li key={count}>
              <Link
                href={`/play?pieces=${count}`}
                className="card group flex h-full flex-col p-4 transition-colors hover:border-[var(--line-strong)] hover:bg-[var(--surface-2)]"
              >
                <span className="num text-2xl text-[var(--fg)]">{count}</span>
                <span className="mt-0.5 text-2xs text-[var(--fg-subtle)]">pieces</span>
                <span className="mt-3 text-sm text-[var(--fg-muted)]">
                  {PIECE_COUNT_BLURB[count]}
                </span>
                <span className="mt-4 inline-flex items-center gap-1 text-2xs font-semibold text-[var(--accent)] opacity-0 transition-opacity group-hover:opacity-100">
                  Start here
                  <Icon name="arrow-right" size={13} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* --------------------------------------------------------------- Modes */}
      <section className="mx-auto w-full max-w-6xl px-4 pt-20 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-2xl sm:text-3xl">More ways to play, coming</h2>
          <p className="text-sm text-[var(--fg-muted)]">
            Every mode uses the same rooms and the same invite link.
          </p>
        </div>
        <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {GAMES.map((game) => {
            const live = game.status === 'live';
            const body = (
              <>
                <div className="flex items-start justify-between gap-3">
                  <span
                    className={`flex size-10 items-center justify-center rounded-xl ${
                      live
                        ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                        : 'bg-[var(--surface-inset)] text-[var(--fg-subtle)]'
                    }`}
                  >
                    <Icon name={game.icon as IconName} size={20} />
                  </span>
                  {live ? <Pill tone="good">Playable now</Pill> : <Pill>Soon</Pill>}
                </div>
                <h3 className="mt-4 text-lg">{game.name}</h3>
                <p className="mt-1.5 text-sm text-[var(--fg-muted)]">{game.blurb}</p>
                <p className="mt-3 text-2xs text-[var(--fg-subtle)]">
                  {game.players.min === game.players.max
                    ? `${game.players.min} players`
                    : `${game.players.min}–${game.players.max} players`}
                </p>
              </>
            );

            return (
              <li key={game.type}>
                {live ? (
                  <Link
                    href="/play"
                    className="card flex h-full flex-col p-5 transition-colors hover:border-[var(--line-strong)] hover:bg-[var(--surface-2)]"
                  >
                    {body}
                  </Link>
                ) : (
                  <div className="card flex h-full flex-col p-5 opacity-70">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {/* ----------------------------------------------------------- Closing CTA */}
      <section className="mx-auto w-full max-w-6xl px-4 pt-20 sm:px-6">
        <div className="card relative overflow-hidden p-8 text-center sm:p-12">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-60"
            style={{
              background:
                'radial-gradient(60% 90% at 50% 0%, var(--accent-soft), transparent 70%)',
            }}
          />
          <div className="relative">
            <h2 className="text-2xl sm:text-3xl">Send it to your favorite person</h2>
            <p className="mx-auto mt-3 max-w-md text-[var(--fg-muted)]">
              Make a room, choose a picture, copy the link. They tap it and they&rsquo;re in — no
              account, no download.
            </p>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
              <ButtonLink href="/play" variant="primary" size="lg">
                Create a room
              </ButtonLink>
              <ButtonLink href="/browse" size="lg">
                <Icon name="image" size={18} />
                See the pictures
              </ButtonLink>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
