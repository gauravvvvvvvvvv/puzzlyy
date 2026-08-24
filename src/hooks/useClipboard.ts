'use client';

/**
 * Copy, and share where the platform offers it.
 *
 * The invite link is the whole product — "send this to your best friend" — so
 * copying it must never silently fail. `navigator.clipboard` is unavailable on
 * insecure origins and in some in-app browsers, hence the `execCommand`
 * fallback; if even that fails the caller gets `false` and can show the link
 * for manual selection instead of pretending it worked.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface Clipboard {
  /** The label most recently copied, cleared after a moment. */
  copied: string | null;
  copy: (text: string, label?: string) => Promise<boolean>;
  /** True when the OS share sheet is available (mostly mobile). */
  canShare: boolean;
  /** Falls back to `copy` when there is no share sheet. */
  share: (data: { title?: string; text?: string; url: string }, label?: string) => Promise<boolean>;
}

const FEEDBACK_MS = 1800;

export function useClipboard(): Clipboard {
  const [copied, setCopied] = useState<string | null>(null);
  const [canShare, setCanShare] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const flash = useCallback((label: string) => {
    setCopied(label);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(null), FEEDBACK_MS);
  }, []);

  const copy = useCallback(
    async (text: string, label = 'link') => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          flash(label);
          return true;
        }
      } catch {
        // Fall through to the legacy path rather than giving up.
      }
      if (legacyCopy(text)) {
        flash(label);
        return true;
      }
      return false;
    },
    [flash],
  );

  const share = useCallback(
    async (data: { title?: string; text?: string; url: string }, label = 'link') => {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        try {
          await navigator.share(data);
          return true;
        } catch (cause) {
          // Dismissing the sheet is not a failure worth reporting, and it is
          // also not worth silently copying behind the player's back.
          if (cause instanceof DOMException && cause.name === 'AbortError') return false;
        }
      }
      return copy(data.url, label);
    },
    [copy],
  );

  return { copied, copy, canShare, share };
}

/** Last resort for insecure origins and older in-app browsers. */
function legacyCopy(text: string): boolean {
  try {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    field.style.pointerEvents = 'none';
    document.body.appendChild(field);
    field.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(field);
    return ok;
  } catch {
    return false;
  }
}
