import { ORIGINAL_ASSETS } from '@/lib/images/originals';
import { hashString } from '@/lib/puzzle/rng';

export function dailyFor(date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  return {
    day,
    image: ORIGINAL_ASSETS[(hashString(day) >>> 0) % ORIGINAL_ASSETS.length],
    seed: hashString('puzzly:' + day) >>> 0,
  };
}
