import { dailyFor } from '@/lib/daily';
export const dynamic = 'force-dynamic';
export async function GET(): Promise<Response> {
  return Response.json(dailyFor(), {headers:{'Cache-Control':'public, max-age=600'}});
}
