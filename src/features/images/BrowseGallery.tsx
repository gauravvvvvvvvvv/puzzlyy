'use client';

/**
 * Browse pictures (spec §3 nav).
 *
 * The same picker the create flow uses, with a different ending: choosing here
 * parks the picture and hands you to /play with it already selected. Browsing and
 * committing are separate moods, and this page is for the first one.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { ImagePicker } from '@/features/images/ImagePicker';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { savePendingImage } from '@/lib/storage/pending';
import type { ImageAsset } from '@/types/models';

export function BrowseGallery() {
  const router = useRouter();
  const [image, setImage] = useState<ImageAsset | null>(null);
  const [going, setGoing] = useState(false);

  // Warm the create route so the hand-off feels instant.
  useEffect(() => {
    router.prefetch('/play');
  }, [router]);

  function use() {
    if (!image) return;
    setGoing(true);
    savePendingImage(image);
    router.push('/play');
  }

  return (
    <div className={image ? 'pb-28' : ''}>
      <ImagePicker value={image} onSelect={setImage} />

      {image ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--line)] bg-[color-mix(in_oklab,var(--bg)_88%,transparent)] backdrop-blur-xl">
          <div className="mx-auto flex w-full max-w-5xl items-center gap-3 px-4 py-3 sm:px-6">
            <img
              src={image.thumbUrl || image.url}
              alt=""
              className="size-11 shrink-0 rounded-md object-cover"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{image.title}</p>
              <p className="num text-2xs text-[var(--fg-subtle)]">
                {image.width && image.height ? `${image.width}×${image.height}` : 'Ready'}
              </p>
            </div>
            <Button variant="ghost" onClick={() => setImage(null)}>
              Clear
            </Button>
            <Button variant="primary" size="lg" disabled={going} onClick={use}>
              {going ? 'Opening…' : 'Make a puzzle'}
              {going ? null : <Icon name="arrow-right" size={18} />}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
