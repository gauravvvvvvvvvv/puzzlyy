import Link from 'next/link';

/** The mark on its own — used in the header, the favicon-ish spots and the footer. */
export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <rect width="32" height="32" rx="9" fill="var(--accent)" />
      {/* A single piece with one knob out and one socket in. */}
      <path
        d="M11 9.5h3.1a1.9 1.9 0 1 1 3.8 0H21a1.5 1.5 0 0 1 1.5 1.5v3.1a1.9 1.9 0 1 0 0 3.8V21a1.5 1.5 0 0 1-1.5 1.5h-3.1a1.9 1.9 0 1 1-3.8 0H11A1.5 1.5 0 0 1 9.5 21v-3.1a1.9 1.9 0 1 1 0-3.8V11A1.5 1.5 0 0 1 11 9.5Z"
        fill="var(--accent-fg)"
        fillOpacity="0.92"
      />
    </svg>
  );
}

export function Logo({
  size = 30,
  showWord = true,
  className = '',
}: {
  size?: number;
  showWord?: boolean;
  className?: string;
}) {
  return (
    <Link
      href="/"
      className={`group inline-flex items-center gap-2.5 rounded-md ${className}`}
      aria-label="Puzzly — home"
    >
      <span className="transition-transform duration-300 ease-[var(--ease-spring)] group-hover:-rotate-6">
        <LogoMark size={size} />
      </span>
      {showWord ? (
        <span
          className="font-[family-name:var(--font-display)] text-[1.28rem] font-semibold tracking-[-0.02em] text-[var(--fg)]"
          style={{ fontVariationSettings: "'SOFT' 60, 'WONK' 1" }}
        >
          Puzzly
        </span>
      ) : null}
    </Link>
  );
}
