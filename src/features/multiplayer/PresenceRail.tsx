'use client';

/**
 * Who is here.
 *
 * The same component serves the lobby (where readiness is the story) and the
 * board (where it is presence and contribution), because the players should feel
 * like the same objects in both places — spec §12 and §19.
 *
 * A player's colour is their identity everywhere: avatar ring here, cursor
 * label on the board, lock outline on their pieces, bar on the results screen.
 */

import { Icon } from '@/components/ui/Icon';
import { playerColor } from '@/lib/multiplayer/identity';
import type { Player } from '@/types/models';

export interface PresenceRailProps {
  players: Player[];
  myId: string;
  /** `lobby` shows ready state; `board` shows connection and piece counts. */
  variant?: 'lobby' | 'board';
  className?: string;
}

export function PresenceRail({
  players,
  myId,
  variant = 'lobby',
  className = '',
}: PresenceRailProps) {
  const ordered = [...players].sort((a, b) => a.joinedAt - b.joinedAt);

  return (
    <ul className={`flex flex-col gap-1.5 ${className}`}>
      {ordered.map((player) => (
        <li key={player.id}>
          <PlayerRow player={player} isMe={player.id === myId} variant={variant} />
        </li>
      ))}
    </ul>
  );
}

function PlayerRow({
  player,
  isMe,
  variant,
}: {
  player: Player;
  isMe: boolean;
  variant: 'lobby' | 'board';
}) {
  const color = playerColor(player.colorId);
  const away = !player.connected;

  return (
    <div
      className="flex items-center gap-2.5 rounded-md px-2 py-1.5"
      style={{
        background: isMe ? 'var(--surface-inset)' : 'transparent',
        opacity: away ? 0.55 : 1,
      }}
    >
      <Avatar player={player} color={color} away={away} />

      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-sm text-[var(--fg)]">
          <span className="truncate">{player.name}</span>
          {isMe ? <span className="text-2xs text-[var(--fg-subtle)]">(you)</span> : null}
          {player.isHost ? (
            <Icon
              name="key"
              size={12}
              label="Host"
              style={{ color: 'var(--fg-subtle)', flexShrink: 0 }}
            />
          ) : null}
        </p>
        <p className="text-2xs text-[var(--fg-subtle)]">
          {away
            ? 'Reconnecting…'
            : variant === 'lobby'
              ? player.ready
                ? 'Ready'
                : 'Getting settled'
              : player.connections > 0
                ? `${player.connections} piece${player.connections === 1 ? '' : 's'} joined`
                : 'Looking for a piece'}
        </p>
      </div>

      {variant === 'lobby' ? (
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-full transition-colors duration-200"
          style={{
            background: player.ready ? 'var(--color-mint-500)' : 'var(--line-strong)',
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Avatar with a coloured ring. Used on its own in tight spots (the board's top
 * bar on mobile), which is why it is exported.
 */
export function Avatar({
  player,
  color = playerColor(player.colorId),
  away = false,
  size = 32,
}: {
  player: Player;
  color?: string;
  away?: boolean;
  size?: number;
}) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.5,
        background: 'var(--surface-2)',
        boxShadow: `inset 0 0 0 2px ${away ? 'var(--line-strong)' : color}`,
      }}
      title={player.name}
    >
      <span aria-hidden="true">{player.avatar}</span>
      <span className="sr-only">{player.name}</span>
    </span>
  );
}
