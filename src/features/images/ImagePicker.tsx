'use client';

/**
 * Choose the picture (spec §11).
 *
 * Four sources behind one grid: Puzzly Originals, stock photos, an upload, and
 * anything already in this device's library. Originals lead because they need no
 * keys and no network round trip to a third party — the picker must never be an
 * empty screen, whatever the deployment has configured.
 *
 * The server-only `@/lib/images` barrel is deliberately not imported here; the
 * browser talks to `/api/images` and takes its category list from the
 * client-safe `@/lib/images/categories`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button, Pill } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { IMAGE_CATEGORIES } from '@/lib/images/categories';
import {
  MAX_UPLOAD_BYTES,
  PrepareError,
  measureImage,
  prepareUpload,
  releasePrepared,
  type PreparedUpload,
} from '@/lib/images/prepare';
import { ApiError, searchImages, uploadImage } from '@/lib/realtime/api';
import { entryToImage, loadLibrary } from '@/lib/storage/library';
import { formatBytes } from '@/lib/format';
import type { ImageAsset, LibraryEntry } from '@/types/models';

type Tab = 'original' | 'stock' | 'upload' | 'library';

const TABS: { id: Tab; label: string; icon: 'sparkle' | 'search' | 'upload' | 'grid' }[] = [
  { id: 'original', label: 'Originals', icon: 'sparkle' },
  { id: 'stock', label: 'Stock photos', icon: 'search' },
  { id: 'upload', label: 'Upload', icon: 'upload' },
  { id: 'library', label: 'My puzzles', icon: 'grid' },
];

const PER_PAGE = 24;

export interface ImagePickerProps {
  value: ImageAsset | null;
  onSelect: (asset: ImageAsset | null) => void;
  className?: string;
}

export function ImagePicker({ value, onSelect, className = '' }: ImagePickerProps) {
  const [tab, setTab] = useState<Tab>('original');

  return (
    <div className={className}>
      <div role="tablist" aria-label="Picture source" className="no-scrollbar -mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
        {TABS.map((entry) => {
          const active = entry.id === tab;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(entry.id)}
              className={`inline-flex h-10 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors ${
                active
                  ? 'bg-[var(--surface-2)] text-[var(--fg)] shadow-[inset_0_0_0_1px_var(--line-strong)]'
                  : 'text-[var(--fg-muted)] hover:bg-[var(--surface-inset)] hover:text-[var(--fg)]'
              }`}
            >
              <Icon name={entry.icon} size={16} />
              {entry.label}
            </button>
          );
        })}
      </div>

      <div className="mt-4">
        {tab === 'upload' ? (
          <UploadPane value={value} onSelect={onSelect} />
        ) : tab === 'library' ? (
          <LibraryPane value={value} onSelect={onSelect} />
        ) : (
          <GalleryPane key={tab} source={tab} value={value} onSelect={onSelect} />
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Gallery (Originals + stock)                                                */
/* -------------------------------------------------------------------------- */

function GalleryPane({
  source,
  value,
  onSelect,
}: {
  source: 'original' | 'stock';
  value: ImageAsset | null;
  onSelect: (asset: ImageAsset) => void;
}) {
  const [category, setCategory] = useState<string | null>(null);
  const [rawQuery, setRawQuery] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<ImageAsset[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fellBack, setFellBack] = useState(false);

  // Typing should not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(rawQuery.trim()), 300);
    return () => clearTimeout(timer);
  }, [rawQuery]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    searchImages({ source, category, q: query || null, page, perPage: PER_PAGE }, controller.signal)
      .then((result) => {
        setItems((current) => (page === 1 ? result.items : [...current, ...result.items]));
        setHasMore(result.hasMore);
        setFellBack(result.fallback);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          cause instanceof ApiError ? cause.message : 'We could not load pictures just now.',
        );
        setLoading(false);
      });

    return () => controller.abort();
  }, [source, category, query, page]);

  const changeFilter = (next: () => void) => {
    next();
    setPage(1);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 sm:max-w-xs">
          <span className="sr-only">Search pictures</span>
          <Icon
            name="search"
            size={16}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--fg-subtle)]"
          />
          <input
            type="search"
            value={rawQuery}
            onChange={(event) => changeFilter(() => setRawQuery(event.target.value))}
            placeholder={source === 'stock' ? 'Mountains, cats, ramen…' : 'Search Originals'}
            className="h-11 w-full rounded-md border border-[var(--line)] bg-[var(--surface-inset)] pr-3 pl-9 text-sm outline-none placeholder:text-[var(--fg-subtle)] focus-visible:border-[var(--accent)]"
          />
        </label>
        {fellBack ? (
          <Pill tone="accent">Showing Originals</Pill>
        ) : null}
      </div>

      <div className="no-scrollbar -mx-1 mt-3 flex gap-1.5 overflow-x-auto px-1 pb-1">
        <CategoryChip
          label="All"
          active={category === null}
          onClick={() => changeFilter(() => setCategory(null))}
        />
        {IMAGE_CATEGORIES.map((entry) => (
          <CategoryChip
            key={entry.id}
            label={entry.label}
            active={category === entry.id}
            onClick={() => changeFilter(() => setCategory(entry.id))}
          />
        ))}
      </div>

      {error ? (
        <Notice tone="bad">{error}</Notice>
      ) : null}

      <ImageGrid items={items} value={value} onSelect={onSelect} loading={loading && page === 1} />

      {hasMore ? (
        <div className="mt-4 flex justify-center">
          <Button onClick={() => setPage((current) => current + 1)} disabled={loading}>
            {loading ? 'Loading…' : 'Show more'}
          </Button>
        </div>
      ) : null}

      {!loading && !error && !items.length ? (
        <p className="py-10 text-center text-sm text-[var(--fg-muted)]">
          Nothing matched that. Try a different word.
        </p>
      ) : null}
    </div>
  );
}

function CategoryChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`h-8 shrink-0 rounded-full px-3 text-2xs font-semibold whitespace-nowrap transition-colors ${
        active
          ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
          : 'bg-[var(--surface-inset)] text-[var(--fg-muted)] hover:text-[var(--fg)]'
      }`}
    >
      {label}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Upload                                                                     */
/* -------------------------------------------------------------------------- */

function UploadPane({
  value,
  onSelect,
}: {
  value: ImageAsset | null;
  onSelect: (asset: ImageAsset) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const preparedRef = useRef<PreparedUpload | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreparedUpload | null>(null);

  // Object URLs outlive the component unless we say otherwise.
  useEffect(
    () => () => {
      releasePrepared(preparedRef.current);
    },
    [],
  );

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      setWarning(null);
      setBusy(true);
      setProgress(0.05);

      try {
        const prepared = await prepareUpload(file, { onProgress: setProgress });
        releasePrepared(preparedRef.current);
        preparedRef.current = prepared;
        setPreview(prepared);

        const { asset, durable } = await uploadImage(prepared.blob, {
          width: prepared.width,
          height: prepared.height,
          title: titleFromFile(file.name),
          color: prepared.color,
        });
        if (!durable) {
          setWarning(
            'This deployment has no permanent image storage configured, so the picture may vanish when the server restarts. The puzzle itself is safe.',
          );
        }
        onSelect(asset);
      } catch (cause) {
        setPreview(null);
        setError(
          cause instanceof PrepareError || cause instanceof ApiError
            ? cause.message
            : 'That upload did not go through. Have another go?',
        );
      } finally {
        setBusy(false);
        setProgress(0);
      }
    },
    [onSelect],
  );

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const uploaded = value?.source === 'upload' ? value : null;

  return (
    <div>
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`card flex flex-col items-center justify-center px-6 py-10 text-center transition-colors ${
          dragging ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : ''
        }`}
      >
        <span className="flex size-12 items-center justify-center rounded-2xl bg-[var(--surface-inset)] text-[var(--fg-muted)]">
          <Icon name="image" size={24} />
        </span>
        <p className="mt-4 text-base font-medium">Use a photo of the two of you</p>
        <p className="mt-1.5 max-w-sm text-sm text-[var(--fg-muted)]">
          Drop it here or pick a file. We shrink it in your browser before it is sent, so nothing
          large leaves your device — JPEG, PNG or WebP, up to {formatBytes(MAX_UPLOAD_BYTES)} once
          shrunk.
        </p>

        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Clear the value so choosing the same file twice still fires.
            event.target.value = '';
            if (file) void handleFile(file);
          }}
        />

        <Button
          variant="primary"
          className="mt-5"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? 'Preparing…' : 'Choose a picture'}
        </Button>

        {busy ? (
          <div className="mt-5 h-1 w-40 overflow-hidden rounded-full bg-[var(--surface-inset)]">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-200"
              style={{ width: `${Math.round(Math.max(0.05, progress) * 100)}%` }}
            />
          </div>
        ) : null}
      </div>

      {error ? <Notice tone="bad">{error}</Notice> : null}
      {warning ? <Notice tone="warn">{warning}</Notice> : null}

      {uploaded ? (
        <div className="card mt-4 flex items-center gap-3 p-3">
          <img
            src={preview?.previewUrl ?? uploaded.thumbUrl}
            alt=""
            className="size-16 shrink-0 rounded-md object-cover"
          />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Icon name="check" size={15} className="text-[var(--color-mint-400)]" />
              Ready to cut up
            </p>
            <p className="num mt-0.5 text-2xs text-[var(--fg-subtle)]">
              {uploaded.width}×{uploaded.height}
              {preview
                ? ` · ${formatBytes(preview.originalBytes)} → ${formatBytes(preview.blob.size)}`
                : ''}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function titleFromFile(name: string): string {
  const base = name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
  return base.slice(0, 60) || 'Your photo';
}

/* -------------------------------------------------------------------------- */
/* Library                                                                    */
/* -------------------------------------------------------------------------- */

function LibraryPane({
  value,
  onSelect,
}: {
  value: ImageAsset | null;
  onSelect: (asset: ImageAsset) => void;
}) {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setEntries(loadLibrary()), []);

  const items = useMemo(
    () => (entries ?? []).map((entry) => ({ entry, asset: entryToImage(entry) })),
    [entries],
  );

  const choose = async (asset: ImageAsset) => {
    setError(null);
    if (asset.width && asset.height) {
      onSelect(asset);
      return;
    }
    // Entries written before we started keeping the whole asset have no
    // dimensions, and the server refuses an asset it cannot size.
    try {
      const size = await measureImage(asset.url);
      onSelect({ ...asset, ...size });
    } catch {
      setError('That picture is no longer available. Try uploading it again.');
    }
  };

  if (entries === null) return <GridSkeleton />;

  if (!entries.length) {
    return (
      <p className="py-10 text-center text-sm text-[var(--fg-muted)]">
        Nothing here yet. Every puzzle you make shows up in this list.
      </p>
    );
  }

  return (
    <div>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <ul className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {items.map(({ entry, asset }) => (
          <li key={entry.puzzleId}>
            <ImageCard
              asset={asset}
              selected={value?.url === asset.url}
              caption={`${entry.pieceCount} pieces`}
              onSelect={() => void choose(asset)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                              */
/* -------------------------------------------------------------------------- */

function ImageGrid({
  items,
  value,
  onSelect,
  loading,
}: {
  items: ImageAsset[];
  value: ImageAsset | null;
  onSelect: (asset: ImageAsset) => void;
  loading: boolean;
}) {
  if (loading && !items.length) return <GridSkeleton />;

  return (
    <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {items.map((asset) => (
        <li key={`${asset.source}:${asset.id}`}>
          <ImageCard
            asset={asset}
            selected={value?.id === asset.id}
            onSelect={() => onSelect(asset)}
          />
        </li>
      ))}
    </ul>
  );
}

function ImageCard({
  asset,
  selected,
  caption,
  onSelect,
}: {
  asset: ImageAsset;
  selected: boolean;
  caption?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`group relative block w-full overflow-hidden rounded-lg text-left transition-[box-shadow,transform] ${
        selected
          ? 'shadow-[0_0_0_2px_var(--accent)]'
          : 'shadow-[0_0_0_1px_var(--line)] hover:shadow-[0_0_0_1px_var(--line-strong)]'
      }`}
    >
      <span
        className="block aspect-[4/3] w-full"
        style={{ background: asset.color ?? 'var(--surface-inset)' }}
      >
        <img
          src={asset.thumbUrl || asset.url}
          alt={asset.title}
          loading="lazy"
          decoding="async"
          className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
        />
      </span>

      <span className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent px-2.5 pt-6 pb-2">
        <span className="min-w-0">
          <span className="block truncate text-2xs font-semibold text-white">{asset.title}</span>
          {caption ? <span className="block text-2xs text-white/70">{caption}</span> : null}
          {asset.credit ? (
            <span className="block truncate text-2xs text-white/70">
              {asset.credit.authorName} · {asset.credit.providerName}
            </span>
          ) : null}
        </span>
        {selected ? (
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-fg)]">
            <Icon name="check" size={13} />
          </span>
        ) : null}
      </span>
    </button>
  );
}

function GridSkeleton() {
  return (
    <ul aria-hidden="true" className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: 8 }, (_, index) => (
        <li
          key={index}
          className="aspect-[4/3] animate-pulse rounded-lg bg-[var(--surface-inset)]"
        />
      ))}
    </ul>
  );
}

function Notice({ tone, children }: { tone: 'bad' | 'warn'; children: React.ReactNode }) {
  const colour =
    tone === 'bad'
      ? 'border-[color-mix(in_oklab,var(--color-danger-500)_40%,transparent)] text-[var(--color-danger-400)]'
      : 'border-[color-mix(in_oklab,var(--color-butter-400)_45%,transparent)] text-[var(--fg-muted)]';
  return (
    <p role="status" className={`mt-3 rounded-md border px-3 py-2 text-sm ${colour}`}>
      {children}
    </p>
  );
}
