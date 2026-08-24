import { Suspense } from 'react';

import { CreateRoomFlow } from '@/features/rooms/CreateRoomFlow';

export const metadata = {
  title: 'Make a room',
  description: 'Pick a picture, pick a difficulty, and get one link to send your friend.',
};

/** The flow reads `?pieces=` and `?solo=`, so it needs a Suspense boundary. */
export default function PlayPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 pt-12 sm:px-6 sm:pt-16">
      <Suspense fallback={<CreateSkeleton />}>
        <CreateRoomFlow />
      </Suspense>
    </div>
  );
}

function CreateSkeleton() {
  return (
    <div aria-hidden="true" className="animate-pulse">
      <div className="h-3 w-40 rounded-full bg-[var(--surface-inset)]" />
      <div className="mt-5 h-10 w-2/3 rounded-lg bg-[var(--surface-inset)]" />
      <div className="mt-4 h-5 w-full max-w-xl rounded-full bg-[var(--surface-inset)]" />
      <div className="mt-12 h-10 w-64 rounded-md bg-[var(--surface-inset)]" />
      <ul className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <li key={index} className="aspect-[4/3] rounded-lg bg-[var(--surface-inset)]" />
        ))}
      </ul>
    </div>
  );
}
