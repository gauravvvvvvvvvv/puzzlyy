/**
 * `GET /api/originals/[id]` — render a Puzzly Original.
 *
 * The picture is generated from the id, so it is byte-identical forever and can
 * be cached hard and immutably. Nothing is stored anywhere, which is what makes
 * the default gallery cost nothing to host.
 *
 * Same-origin on purpose: the puzzle canvas reads pixels back to build its sprite
 * atlas, and a cross-origin image would taint it.
 */

import { originalById, renderOriginalSvg } from '@/lib/images/originals';
import { fail } from '@/lib/server/validate';

export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const spec = originalById(id);
  if (!spec) return fail('No such image.', 404);

  return new Response(renderOriginalSvg(spec), {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=31536000, immutable',
      // Belt and braces: the document has no scripts or external references.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
