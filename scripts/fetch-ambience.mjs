#!/usr/bin/env node
// Download and self-host licensed CC0 field recordings at build time.
// Source and credits: https://github.com/twtrubiks/moonseal/blob/main/public/audio/README.md
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const names = ['birds', 'fireplace', 'ocean', 'rain', 'stream', 'thunder', 'wind'];
const upstream = 'https://raw.githubusercontent.com/twtrubiks/moonseal/8e7ef422753e12083a152671ae33aef73c40f4cd/public/audio/';
const dest = join(process.cwd(), 'public', 'ambience');
await mkdir(dest, { recursive: true });
await Promise.all(names.map(async name => {
  const file = join(dest, name + '.mp3');
  try { if ((await stat(file)).size > 20000) return; } catch {}
  let reason;
  for (let attempt = 0; attempt < 3; attempt++) {
    const temp = file + '.part';
    try {
      const response = await fetch(upstream + name + '.mp3', {signal: AbortSignal.timeout(25000)});
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 20000) throw new Error('Invalid audio response');
      await writeFile(temp, bytes);
      await rename(temp, file);
      console.log('Downloaded ambience:', name, Math.round(bytes.length / 1024) + ' KB');
      return;
    } catch (error) {
      reason = error;
      await rm(temp, {force:true});
      if (attempt < 2) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw new Error('Unable to download '+name+' ambience: '+String(reason));
}));
