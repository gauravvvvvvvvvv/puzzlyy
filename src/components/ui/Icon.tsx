/**
 * Icon set.
 *
 * Inline SVG rather than an icon package: there are about twenty glyphs in the
 * whole product, each is a few hundred bytes, and inlining them means no extra
 * request, no flash of missing icons, and `currentColor` inheritance so an icon
 * always matches the text beside it.
 *
 * Every icon is decorative by default (`aria-hidden`), because it sits next to a
 * label or inside a button that has its own accessible name. Pass a `label` when
 * an icon really is the only thing conveying meaning.
 */

import type { SVGProps } from 'react';

export type IconName =
  | 'jigsaw'
  | 'scramble'
  | 'spot'
  | 'memory'
  | 'search'
  | 'key'
  | 'plus'
  | 'link'
  | 'check'
  | 'copy'
  | 'share'
  | 'upload'
  | 'image'
  | 'sparkle'
  | 'users'
  | 'play'
  | 'again'
  | 'arrow-right'
  | 'arrow-left'
  | 'zoom-in'
  | 'zoom-out'
  | 'fit'
  | 'eye'
  | 'bulb'
  | 'undo'
  | 'redo'
  | 'smile'
  | 'reaction'
  | 'pin'
  | 'volume'
  | 'settings'
  | 'sun'
  | 'moon'
  | 'trash'
  | 'clock'
  | 'trophy'
  | 'flag'
  | 'wifi'
  | 'close'
  | 'grid';

/** Paths are drawn on a 24×24 grid with a 1.7 stroke, so weights match. */
const PATHS: Record<IconName, string> = {
  jigsaw:
    'M10 4.5h1.6a1.4 1.4 0 1 1 2.8 0H16a1.5 1.5 0 0 1 1.5 1.5v2.1a1.4 1.4 0 1 0 0 2.8V13a1.5 1.5 0 0 1-1.5 1.5h-2.1a1.4 1.4 0 1 1-2.8 0H8.5A1.5 1.5 0 0 1 7 13v-1.6a1.4 1.4 0 1 1 0-2.8V6A1.5 1.5 0 0 1 8.5 4.5H10Z M6 16.5h5a1.5 1.5 0 0 1 1.5 1.5v1.5H6a1.5 1.5 0 0 1-1.5-1.5v-1.5H6Z',
  scramble:
    'M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM14.6 15.2h4.9M17 12.8v4.8',
  spot: 'M9 4.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9ZM15.5 10.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9ZM15.5 13v4M13.5 15h4',
  memory:
    'M4.5 5.5h6v6h-6zM13.5 5.5h6v6h-6zM4.5 14.5h6v5h-6zM13.5 14.5h6v5h-6zM6.5 8.5h2M15.5 8.5h2',
  search: 'M10.5 4.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12ZM15 15l4.5 4.5',
  key: 'M15 4.5a4.5 4.5 0 1 0-3.6 7.2L4.5 18.5v1h3v-2h2v-2h1.7A4.5 4.5 0 0 0 15 4.5ZM16 8h.01',
  plus: 'M12 5.5v13M5.5 12h13',
  link: 'M10 13.9a3.6 3.6 0 0 0 5.1 0l2.8-2.8a3.6 3.6 0 0 0-5.1-5.1l-1 1M14 10.1a3.6 3.6 0 0 0-5.1 0l-2.8 2.8a3.6 3.6 0 0 0 5.1 5.1l1-1',
  check: 'M5 12.8l4.4 4.2L19 7.5',
  copy: 'M9 9.5a2 2 0 0 1 2-2h6.5a2 2 0 0 1 2 2V16a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2V9.5ZM15 7.5V6a2 2 0 0 0-2-2H6.5a2 2 0 0 0-2 2v6.5a2 2 0 0 0 2 2H8',
  share: 'M12 15.5V4.5M8.5 8L12 4.5 15.5 8M5.5 13v5a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5v-5',
  upload:
    'M12 16V5M8.5 8.5 12 5l3.5 3.5M5 14.5V18a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 18v-3.5',
  image:
    'M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-11ZM9 10a1.2 1.2 0 1 0 0-2.4A1.2 1.2 0 0 0 9 10ZM5 16.5l4-4 3.5 3.5 2.5-2.5 4 4',
  sparkle:
    'M12 4.5l1.6 4.3 4.4 1.7-4.4 1.7L12 16.5l-1.6-4.3L6 10.5l4.4-1.7L12 4.5ZM18 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z',
  users:
    'M9 11a3.2 3.2 0 1 0 0-6.5A3.2 3.2 0 0 0 9 11ZM3.5 19.5c0-2.8 2.5-5 5.5-5s5.5 2.2 5.5 5M15.5 5.2a3.2 3.2 0 0 1 0 6.1M17 14.9c2 .7 3.5 2.5 3.5 4.6',
  play: 'M8 5.5l10 6.5-10 6.5v-13Z',
  again:
    'M19 12a7 7 0 1 1-2.4-5.3M19.5 4.5V9H15',
  'arrow-right': 'M4.5 12h14M13 6.5l5.5 5.5-5.5 5.5',
  'arrow-left': 'M19.5 12h-14M11 6.5 5.5 12l5.5 5.5',
  'zoom-in': 'M10.5 4.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12ZM15 15l4.5 4.5M10.5 8v5M8 10.5h5',
  'zoom-out': 'M10.5 4.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12ZM15 15l4.5 4.5M8 10.5h5',
  fit: 'M5 9V6a1 1 0 0 1 1-1h3M19 9V6a1 1 0 0 0-1-1h-3M5 15v3a1 1 0 0 0 1 1h3M19 15v3a1 1 0 0 1-1 1h-3',
  eye: 'M3.5 12S6.8 6.5 12 6.5 20.5 12 20.5 12 17.2 17.5 12 17.5 3.5 12 3.5 12ZM12 14.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z',
  bulb: 'M9.2 16.5a5.5 5.5 0 1 1 5.6 0v1.6a1.4 1.4 0 0 1-1.4 1.4h-2.8a1.4 1.4 0 0 1-1.4-1.4v-1.6ZM10 19.5h4',
  undo: 'M4.5 9.5h8.8a5 5 0 0 1 0 10H8M4.5 9.5 8 6M4.5 9.5 8 13',
  redo: 'M19.5 9.5h-8.8a5 5 0 0 0 0 10H16M19.5 9.5 16 6M19.5 9.5 16 13',
  smile:
    'M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15ZM9 10h.01M15 10h.01M8.8 13.6a4 4 0 0 0 6.4 0',
  // A speech bubble with a heart in it. A smiley would be the obvious choice and
  // is the wrong one: the popover is not "emoji", it is the whole way you say
  // something to the person you are playing with — a reaction, or "look here".
  reaction:
    'M6.5 4.5h11A2.5 2.5 0 0 1 20 7v7a2.5 2.5 0 0 1-2.5 2.5h-3.7L10 20.5V16.5H6.5A2.5 2.5 0 0 1 4 14V7a2.5 2.5 0 0 1 2.5-2.5Z M12 13.2c-3-2-3.6-3-3.6-4.2a2 2 0 0 1 3.6-1.2 2 2 0 0 1 3.6 1.2c0 1.2-.6 2.2-3.6 4.2Z',
  pin: 'M12 20.6c3.7-4.2 5.6-7 5.6-9.6a5.6 5.6 0 1 0-11.2 0c0 2.6 1.9 5.4 5.6 9.6Z M12 13.2a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6Z',
  volume: 'M4.5 9.5h3l4-3.5v12l-4-3.5h-3ZM15 9.5a3.5 3.5 0 0 1 0 5M17.6 7a7 7 0 0 1 0 10',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12 3.5l1 2.2 2.4-.5 1 1-.5 2.4 2.2 1v1.4l-2.2 1 .5 2.4-1 1-2.4-.5-1 2.2h-1.4l-1-2.2-2.4.5-1-1 .5-2.4-2.2-1v-1.4l2.2-1-.5-2.4 1-1 2.4.5 1-2.2H12Z',
  sun: 'M12 15.6a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2ZM12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18',
  moon: 'M19 14.5A7.5 7.5 0 1 1 9.5 5a6 6 0 0 0 9.5 9.5Z',
  trash: 'M5.5 7.5h13M9 7.5V5.8a1.3 1.3 0 0 1 1.3-1.3h3.4A1.3 1.3 0 0 1 15 5.8v1.7M7 7.5l.8 11a1.3 1.3 0 0 0 1.3 1.2h5.8a1.3 1.3 0 0 0 1.3-1.2l.8-11M10.5 11v5M13.5 11v5',
  clock: 'M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15ZM12 8v4.3l3 1.8',
  trophy:
    'M8 4.5h8v4a4 4 0 0 1-8 0v-4ZM8 6H5.5v1.5A3 3 0 0 0 8.3 10.5M16 6h2.5v1.5a3 3 0 0 1-2.8 3M12 12.5v3M9 19.5h6l-.5-2.5h-5L9 19.5Z',
  flag: 'M6 4.5v15M6 5.5h9.5l-1.2 3 1.2 3H6',
  wifi: 'M4.5 9.5a11 11 0 0 1 15 0M7.5 13a7 7 0 0 1 9 0M10.5 16.4a3 3 0 0 1 3 0M12 19.4h.01',
  close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  grid: 'M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z',
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'children'> {
  name: IconName;
  /** Pixel size. 20 suits inline text, 24 a toolbar button. */
  size?: number;
  /** Give the icon an accessible name when nothing else labels it. */
  label?: string;
}

export function Icon({ name, size = 20, label, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      focusable="false"
      {...rest}
    >
      {label ? <title>{label}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}
