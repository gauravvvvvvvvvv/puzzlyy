import { BrowseGallery } from '@/features/images/BrowseGallery';

export const metadata = {
  title: 'Browse pictures',
  description:
    'Puzzly Originals, stock photos and your own uploads — pick one and turn it into a puzzle.',
};

export default function BrowsePage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 pt-12 pb-24 sm:px-6 sm:pt-16">
      <header className="mb-8">
        <p className="eyebrow mb-3">Pictures</p>
        <h1 className="text-3xl sm:text-4xl">Find something worth a couple of hours</h1>
        <p className="mt-3 max-w-xl text-[var(--fg-muted)]">
          Puzzly Originals are drawn by us and always available. Add your own photo if you would
          rather solve something that means something.
        </p>
      </header>

      <BrowseGallery />
    </div>
  );
}
