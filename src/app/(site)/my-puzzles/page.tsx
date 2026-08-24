import { PuzzleLibrary } from '@/features/puzzle/PuzzleLibrary';

export const metadata = {
  title: 'My puzzles',
  description: 'Everything you have cut up, with your best times. Kept on this device.',
};

export default function MyPuzzlesPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 pt-12 pb-24 sm:px-6 sm:pt-16">
      <header className="mb-8">
        <p className="eyebrow mb-3">On this device</p>
        <h1 className="text-3xl sm:text-4xl">My puzzles</h1>
        <p className="mt-3 max-w-xl text-[var(--fg-muted)]">
          Every picture you have turned into a puzzle, with your best time on each. There is no
          account behind this — clearing your browser data clears the shelf.
        </p>
      </header>

      <PuzzleLibrary />
    </div>
  );
}
