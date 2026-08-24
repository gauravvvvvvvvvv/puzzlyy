/**
 * A small, strict stand-in for the Supabase services Puzzly talks to.
 *
 *   node scripts/fake-supabase.mjs [port]        # default 54321
 *
 * ## Why this exists
 *
 * Every check in `smoke.mjs` and `smoke-edge.mjs` passes against the in-memory
 * store — which is not the code that runs in production. `SupabaseRoomStore`,
 * `SupabaseBlobStore` and `SupabaseBroadcaster` are selected only when
 * credentials are present, so on a laptop with no Supabase project they are
 * *never executed at all*. That is not a small gap: the compare-and-swap in
 * `casRoom` is the entire reason multiplayer is correct across Vercel instances
 * (spec §1), and it had no test.
 *
 * It is also how a real bug survived: `putChallenge` never wrote
 * `challenges.expires_at`, which the schema declares NOT NULL. Postgres would
 * have rejected every challenge, PostgREST would have said 400, and the old
 * `upsert` discarded the status — so the API answered `201` with a link to a row
 * that did not exist. Nothing in memory mode can see that, because a Map has no
 * constraints.
 *
 * So the point of this file is to be **unforgiving in the same places Postgres
 * is**:
 *
 *  - NOT NULL columns are read out of `sql/schema.sql` at startup rather than
 *    restated here, so the emulator cannot drift away from the real schema. Add
 *    a NOT NULL column to the schema and this starts failing writes that omit
 *    it, which is exactly the alarm you want.
 *  - primary-key collisions are 409, so `createRoom`'s code-collision retry is
 *    a real path.
 *  - `PATCH ?version=eq.N` matches zero rows when the version has moved on,
 *    which is what makes the CAS retry loop observable.
 *  - the storage bucket enforces its declared mime types and size ceiling.
 *
 * This is emphatically not a Postgres. It implements only the handful of
 * PostgREST constructs `store.ts` actually sends, and it fails loudly on
 * anything it does not recognise rather than quietly returning `[]` — a silent
 * empty result is how a query bug turns into "the room vanished".
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const PORT = Number(process.argv[2] ?? 54321);
const SCHEMA_URL = new URL('../sql/schema.sql', import.meta.url);

/* -------------------------------------------------------------------------- */
/* Schema, read from the file the production database is built from           */
/* -------------------------------------------------------------------------- */

/**
 * Drop `-- comments` so they cannot be mistaken for syntax.
 *
 * Two reasons, both learned the hard way from this very file: the bucket
 * declaration has `8388608,  -- 8 MB hard ceiling` between two values it needs to
 * read across, and a column with a trailing comment that happens to contain the
 * words "default" or "not null" would otherwise be misclassified. Naive enough to
 * corrupt a string literal containing `--`; `schema.sql` has none, and a fake
 * server that mis-parses loudly at startup is a cheap price.
 */
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');

/**
 * Pull `{ primaryKey, required[] }` out of the real DDL.
 *
 * "Required" means NOT NULL *without* a default — those are the columns an
 * INSERT has to name. A NOT NULL column that has a default (`status`, `version`)
 * is fine to omit, and treating it as required would produce false alarms.
 */
function parseSchema(sql) {
  const tables = {};
  const tableRe = /create table if not exists public\.(\w+)\s*\(([\s\S]*?)\n\);/g;

  for (const [, name, body] of sql.matchAll(tableRe)) {
    const required = [];
    let primaryKey = null;

    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim().replace(/,$/, '');
      if (!line || line.startsWith('--')) continue;
      const column = line.match(/^(\w+)\s+/)?.[1];
      if (!column) continue;

      const isPk = /\bprimary key\b/i.test(line);
      if (isPk) primaryKey = column;
      // A primary key is implicitly NOT NULL and never has a useful default.
      const notNull = isPk || /\bnot null\b/i.test(line);
      const hasDefault = /\bdefault\b/i.test(line);
      if (notNull && !hasDefault) required.push(column);
    }

    tables[name] = { primaryKey, required };
  }
  return tables;
}

/** Bucket id -> declared mime allow-list and size ceiling. */
function parseBuckets(sql) {
  const buckets = {};
  const re =
    /insert into storage\.buckets[\s\S]*?values\s*\(\s*'([^']+)'\s*,\s*'[^']*'\s*,\s*(?:true|false)\s*,\s*(\d+)\s*,\s*array\[([^\]]*)\]/gi;
  for (const [, id, limit, types] of sql.matchAll(re)) {
    buckets[id] = {
      fileSizeLimit: Number(limit),
      mimeTypes: [...types.matchAll(/'([^']+)'/g)].map((m) => m[1]),
    };
  }
  return buckets;
}

const schemaSql = stripComments(await readFile(SCHEMA_URL, 'utf8'));
const TABLES = parseSchema(schemaSql);
const BUCKETS = parseBuckets(schemaSql);

// A regex that quietly matches nothing would turn this whole file into a server
// that says 404 to everything — the failure would look like a bug in `store.ts`
// rather than in the parser. Assert the shape we know `schema.sql` has.
for (const [name, { primaryKey, required }] of Object.entries(TABLES)) {
  if (!primaryKey) throw new Error(`parseSchema: no primary key found for ${name}`);
  if (!required.includes('data')) {
    throw new Error(`parseSchema: ${name}.data should be NOT NULL — parser is wrong`);
  }
}
for (const table of ['rooms', 'puzzles', 'images', 'challenges']) {
  if (!TABLES[table]) throw new Error(`parseSchema: missed table ${table}`);
}
if (!Object.keys(BUCKETS).length) {
  throw new Error('parseBuckets: no storage bucket found in sql/schema.sql');
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

/** table -> Map<primaryKeyValue, row> */
const db = new Map(Object.keys(TABLES).map((t) => [t, new Map()]));
/** `${bucket}/${name}` -> { body: Buffer, contentType } */
const objects = new Map();

const stats = {
  broadcasts: 0,
  messages: 0,
  casAttempts: 0,
  casConflicts: 0,
  rejections: [],
  unsupported: [],
};

/**
 * Artificial REST latency, in milliseconds, settable via `POST /__latency?ms=N`.
 *
 * Without it the compare-and-swap retry loop in `session.ts` is unreachable: this
 * server answers in well under a millisecond, so two "simultaneous" requests
 * still read and write in neat sequence and every CAS succeeds first try. Real
 * Postgres sits tens of milliseconds away, which is long enough for two instances
 * to read the same version and both try to claim it. Delaying reads reproduces
 * that window on demand, so the retry path can be tested rather than assumed.
 */
let restLatencyMs = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------------------- */
/* PostgREST-ish querying                                                     */
/* -------------------------------------------------------------------------- */

const RESERVED = new Set(['select', 'limit', 'order', 'offset', 'on_conflict']);

/** `data->puzzle->>imageId` reaches into the jsonb column. */
function resolve(row, path) {
  if (!path.includes('->')) return row[path];
  const [head, ...rest] = path.split(/->>?/);
  let cursor = row[head];
  for (const key of rest) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function parseFilters(params) {
  const filters = [];
  for (const [key, raw] of params) {
    if (RESERVED.has(key)) continue;
    const split = raw.indexOf('.');
    if (split === -1) {
      stats.unsupported.push(`${key}=${raw}`);
      continue;
    }
    filters.push({ path: key, op: raw.slice(0, split), value: raw.slice(split + 1) });
  }
  return filters;
}

function matches(row, filters) {
  return filters.every(({ path, op, value }) => {
    const actual = resolve(row, path);
    switch (op) {
      case 'eq':
        // Numbers arrive as strings in a query string; compare as strings so
        // `version=eq.7` matches a numeric 7.
        return actual !== undefined && actual !== null && String(actual) === value;
      case 'lt':
        return actual !== undefined && actual !== null && String(actual) < value;
      case 'gt':
        return actual !== undefined && actual !== null && String(actual) > value;
      default:
        // Better to shout than to silently match nothing.
        stats.unsupported.push(`${path}=${op}.${value}`);
        return false;
    }
  });
}

function project(row, select) {
  if (!select || select === '*') return row;
  const out = {};
  for (const column of select.split(',')) out[column.trim()] = row[column.trim()];
  return out;
}

function sortRows(rows, order) {
  if (!order) return rows;
  const [column, direction = 'asc'] = order.split('.');
  return [...rows].sort((a, b) => {
    const x = resolve(a, column);
    const y = resolve(b, column);
    if (x === y) return 0;
    const less = String(x) < String(y);
    return (less ? -1 : 1) * (direction.startsWith('desc') ? -1 : 1);
  });
}

/** The check that earns this file its keep. */
function missingColumns(table, row) {
  return TABLES[table].required.filter(
    (column) => row[column] === undefined || row[column] === null,
  );
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                   */
/* -------------------------------------------------------------------------- */

function send(res, status, body, headers = {}) {
  const payload = body === null || body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/** PostgREST's not-null violation, close enough to be recognisable in a log. */
function notNullViolation(res, table, columns) {
  const detail = `null value in column "${columns[0]}" of relation "${table}" violates not-null constraint`;
  stats.rejections.push(`${table}: ${columns.join(', ')}`);
  console.error(`  [fake-supabase] 400  ${detail}`);
  send(res, 400, { code: '23502', message: detail, details: null, hint: null });
}

function handleRest(req, res, url, bodyText) {
  const table = url.pathname.replace(/^\/rest\/v1\//, '').split('/')[0];
  if (!db.has(table)) {
    console.error(`  [fake-supabase] 404  unknown table ${table}`);
    return send(res, 404, { message: `relation "public.${table}" does not exist` });
  }

  const rows = db.get(table);
  const { primaryKey } = TABLES[table];
  const params = url.searchParams;
  const filters = parseFilters(params);
  const select = params.get('select');
  const limit = params.get('limit') ? Number(params.get('limit')) : undefined;
  const prefer = req.headers.prefer ?? '';
  const wantsRepresentation = prefer.includes('return=representation');

  if (req.method === 'GET') {
    let found = [...rows.values()].filter((row) => matches(row, filters));
    found = sortRows(found, params.get('order'));
    if (limit !== undefined) found = found.slice(0, limit);
    return send(
      res,
      200,
      found.map((row) => project(row, select)),
    );
  }

  if (req.method === 'POST') {
    const incoming = JSON.parse(bodyText || '{}');
    const batch = Array.isArray(incoming) ? incoming : [incoming];
    const merge = prefer.includes('resolution=merge-duplicates');
    const written = [];

    for (const row of batch) {
      const missing = missingColumns(table, row);
      if (missing.length) return notNullViolation(res, table, missing);

      const key = row[primaryKey];
      if (rows.has(key) && !merge) {
        // Duplicate key. `createRoom` depends on seeing this as 409.
        return send(res, 409, {
          code: '23505',
          message: `duplicate key value violates unique constraint "${table}_pkey"`,
        });
      }
      const next = rows.has(key) ? { ...rows.get(key), ...row } : { ...row };
      rows.set(key, next);
      written.push(next);
    }

    return send(
      res,
      201,
      wantsRepresentation ? written.map((row) => project(row, select)) : null,
    );
  }

  if (req.method === 'PATCH') {
    const patch = JSON.parse(bodyText || '{}');
    // A version-scoped PATCH is a compare-and-swap; count both halves so a test
    // can prove contention actually happened rather than assuming it.
    const isCas = filters.some((f) => f.path === 'version');
    if (isCas) stats.casAttempts += 1;

    const target = [...rows.values()].filter((row) => matches(row, filters));
    if (isCas && target.length === 0) stats.casConflicts += 1;

    const written = [];
    for (const row of target) {
      const next = { ...row, ...patch };
      const missing = missingColumns(table, next);
      if (missing.length) return notNullViolation(res, table, missing);
      rows.set(next[primaryKey], next);
      written.push(next);
    }

    return send(
      res,
      200,
      wantsRepresentation ? written.map((row) => project(row, select)) : null,
    );
  }

  if (req.method === 'DELETE') {
    // A DELETE with no filter would truncate the table. PostgREST allows it;
    // Puzzly never sends one, so treat it as a bug rather than obeying.
    if (!filters.length) {
      stats.unsupported.push(`unfiltered DELETE ${table}`);
      return send(res, 400, { message: 'unfiltered delete refused by fake-supabase' });
    }
    for (const [key, row] of [...rows]) {
      if (matches(row, filters)) rows.delete(key);
    }
    return send(res, 204, null);
  }

  return send(res, 405, { message: `method ${req.method} not allowed` });
}

function handleStorage(req, res, url, bodyBuffer) {
  // /storage/v1/object/{bucket}/{name}
  const rest = url.pathname.replace(/^\/storage\/v1\/object\//, '');
  const slash = rest.indexOf('/');
  const bucket = rest.slice(0, slash);
  const name = rest.slice(slash + 1);
  const key = `${bucket}/${name}`;
  const spec = BUCKETS[bucket];

  if (!spec) {
    console.error(`  [fake-supabase] 404  no such bucket ${bucket}`);
    return send(res, 404, { message: 'Bucket not found' });
  }

  if (req.method === 'POST' || req.method === 'PUT') {
    const contentType = req.headers['content-type'] ?? 'application/octet-stream';
    if (!spec.mimeTypes.includes(contentType)) {
      stats.rejections.push(`storage: mime ${contentType}`);
      return send(res, 400, { message: `mime type ${contentType} is not supported` });
    }
    if (bodyBuffer.length > spec.fileSizeLimit) {
      stats.rejections.push(`storage: ${bodyBuffer.length} bytes`);
      return send(res, 413, { message: 'The object exceeded the maximum allowed size' });
    }
    if (objects.has(key) && req.headers['x-upsert'] !== 'true') {
      return send(res, 409, { message: 'The resource already exists' });
    }
    objects.set(key, { body: bodyBuffer, contentType });
    return send(res, 200, { Key: key });
  }

  if (req.method === 'GET') {
    const object = objects.get(key);
    if (!object) return send(res, 404, { message: 'Object not found' });
    res.writeHead(200, {
      'Content-Type': object.contentType,
      'Content-Length': object.body.length,
    });
    return res.end(object.body);
  }

  if (req.method === 'DELETE') {
    if (!objects.delete(key)) return send(res, 404, { message: 'Object not found' });
    return send(res, 200, { message: 'Successfully deleted' });
  }

  return send(res, 405, { message: `method ${req.method} not allowed` });
}

/* -------------------------------------------------------------------------- */

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, `http://localhost:${PORT}`);

    try {
      if (url.pathname === '/__latency') {
        restLatencyMs = Number(url.searchParams.get('ms') ?? 0) || 0;
        return send(res, 200, { restLatencyMs });
      }

      if (url.pathname === '/__stats') {
        return send(res, 200, {
          ...stats,
          rows: Object.fromEntries([...db].map(([t, rows]) => [t, rows.size])),
          objects: objects.size,
        });
      }

      if (url.pathname === '/__reset') {
        for (const rows of db.values()) rows.clear();
        objects.clear();
        Object.assign(stats, {
          broadcasts: 0,
          messages: 0,
          casAttempts: 0,
          casConflicts: 0,
          rejections: [],
          unsupported: [],
        });
        return send(res, 200, { ok: true });
      }

      // Realtime broadcast: accept and count. Nothing subscribes here — the
      // point is that the server *published*, which is all the server can know.
      if (url.pathname === '/realtime/v1/api/broadcast') {
        const parsed = JSON.parse(body.toString('utf8') || '{}');
        stats.broadcasts += 1;
        stats.messages += parsed.messages?.length ?? 0;
        return send(res, 202, {});
      }

      if (url.pathname.startsWith('/rest/v1/')) {
        // Sleep *before* touching state, so two concurrent requests both read the
        // same version before either writes — that is the race the retry loop
        // exists for.
        if (restLatencyMs) await sleep(restLatencyMs);
        return handleRest(req, res, url, body.toString('utf8'));
      }

      if (url.pathname.startsWith('/storage/v1/object/')) {
        return handleStorage(req, res, url, body);
      }

      stats.unsupported.push(`${req.method} ${url.pathname}`);
      console.error(`  [fake-supabase] 404  ${req.method} ${url.pathname}`);
      return send(res, 404, { message: 'not implemented by fake-supabase' });
    } catch (error) {
      console.error('  [fake-supabase] 500', error);
      return send(res, 500, { message: String(error) });
    }
  });
});

server.listen(PORT, () => {
  const tables = Object.entries(TABLES)
    .map(([name, { required }]) => `${name}(${required.join('+')})`)
    .join(' ');
  console.log(`fake-supabase listening on http://localhost:${PORT}`);
  console.log(`  NOT NULL, from sql/schema.sql: ${tables}`);
  console.log(`  buckets: ${Object.keys(BUCKETS).join(', ') || 'none'}`);
});
