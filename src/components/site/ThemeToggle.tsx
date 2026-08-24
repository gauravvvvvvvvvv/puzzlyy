'use client';

/**
 * Light/dark switch.
 *
 * The button reads the theme from the DOM rather than from state on first render,
 * because the bootstrap script in `<head>` already decided it — trusting React's
 * initial state instead would mean the icon disagreed with the page until mount.
 */

import { useEffect, useState } from 'react';

import { IconButton } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { applyTheme, currentTheme, saveTheme, type ThemeChoice } from '@/lib/storage/theme';

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useState<ThemeChoice>('dark');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setTheme(currentTheme());
    setReady(true);
  }, []);

  function toggle() {
    const next: ThemeChoice = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
    saveTheme(next);
  }

  const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';

  return (
    <IconButton label={label} compact={compact} onClick={toggle} aria-pressed={theme === 'light'}>
      {/* Before mount the icon is hidden rather than wrong. */}
      <span className={ready ? 'contents' : 'opacity-0'}>
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={compact ? 18 : 20} />
      </span>
    </IconButton>
  );
}
