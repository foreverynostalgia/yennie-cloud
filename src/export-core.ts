// Temporary owner-only data export for migrating off the current host.
// Enabled only while the EXPORT_TOKEN runtime secret is set (>= 32 chars).
// Remove this route and the secret once the export has been verified.
//
// GET /api/export?op=manifest                      tables, schema SQL, row counts
// GET /api/export?op=rows&table=T&offset=N&limit=L rows of one table (by rowid)
// GET /api/export?op=r2list&cursor=C               one page of R2 object metadata
// GET /api/export?op=r2get&key=K                   raw bytes of one R2 object
//
// Auth: header `X-Export-Token: <EXPORT_TOKEN>`. Read-only; never writes.

type ExportD1 = {prepare(sql: string): {bind(...v: unknown[]): {all(): Promise<{results: Record<string, unknown>[]}>; first(): Promise<Record<string, unknown> | null>}; all(): Promise<{results: Record<string, unknown>[]}>; first(): Promise<Record<string, unknown> | null>}};
type ExportR2Object = {key: string; size: number; etag: string; uploaded: Date; httpMetadata?: Record<string, unknown>; customMetadata?: Record<string, string>};
type ExportR2 = {list(o: {cursor?: string; limit?: number; include?: string[]}): Promise<{objects: ExportR2Object[]; truncated: boolean; cursor?: string}>; get(key: string): Promise<(ExportR2Object & {body: ReadableStream}) | null>};
type ExportEnv = {db?: ExportD1; bucket?: ExportR2; token?: string};

const exportNoStore = {'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex'};
const exportJson = (data: unknown, status = 200) => new Response(JSON.stringify(data), {status, headers: {...exportNoStore, 'Content-Type': 'application/json; charset=utf-8'}});

async function exportTokenOk(given: string, expected: string) {
  if (expected.length < 32 || !given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(given)), crypto.subtle.digest('SHA-256', enc.encode(expected))]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function exportB64(buf: ArrayBuffer | Uint8Array) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function exportCell(v: unknown): unknown {
  if (v instanceof ArrayBuffer || v instanceof Uint8Array) return {$b64: exportB64(v)};
  if (Array.isArray(v) && v.every(n => Number.isInteger(n) && n >= 0 && n < 256)) return {$b64: exportB64(new Uint8Array(v as number[]))};
  return v;
}

async function exportTables(db: ExportD1) {
  const {results} = await db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all();
  return results as {name: string; sql: string}[];
}

export async function handleExport(request: Request, env: ExportEnv): Promise<Response> {
  if (!env.token || env.token.length < 32) return exportJson({error: 'Not Found'}, 404);
  if (request.method !== 'GET') return exportJson({error: 'Method Not Allowed'}, 405);
  if (!(await exportTokenOk(request.headers.get('x-export-token') || '', env.token))) return exportJson({error: 'Forbidden'}, 403);
  const url = new URL(request.url), op = url.searchParams.get('op');
  try {
    if (op === 'manifest') {
      const tables = env.db ? await exportTables(env.db) : [];
      const out = [];
      for (const t of tables) {
        const row = await env.db!.prepare(`SELECT COUNT(*) AS n FROM "${t.name.replace(/"/g, '""')}"`).first();
        out.push({name: t.name, sql: t.sql, rows: Number(row?.n ?? 0)});
      }
      const indexes = env.db ? (await env.db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type IN ('index','trigger','view') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND tbl_name NOT LIKE '_cf_%' ORDER BY name").all()).results : [];
      return exportJson({exportedAt: new Date().toISOString(), d1: !!env.db, r2: !!env.bucket, tables: out, indexes});
    }
    if (op === 'rows') {
      if (!env.db) return exportJson({error: 'No D1 binding'}, 404);
      const name = url.searchParams.get('table') || '';
      if (!(await exportTables(env.db)).some(t => t.name === name)) return exportJson({error: 'Unknown table'}, 400);
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0));
      const limit = Math.min(1000, Math.max(1, Math.floor(Number(url.searchParams.get('limit')) || 200)));
      const q = `"${name.replace(/"/g, '""')}"`;
      let results: Record<string, unknown>[];
      try {
        results = (await env.db.prepare(`SELECT * FROM ${q} ORDER BY rowid LIMIT ? OFFSET ?`).bind(limit, offset).all()).results;
      } catch {
        // WITHOUT ROWID tables: fall back to primary-key/first-column order.
        results = (await env.db.prepare(`SELECT * FROM ${q} ORDER BY 1 LIMIT ? OFFSET ?`).bind(limit, offset).all()).results;
      }
      const rows = results.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, exportCell(v)])));
      return exportJson({table: name, offset, limit, rows, done: rows.length < limit});
    }
    if (op === 'r2list') {
      if (!env.bucket) return exportJson({error: 'No R2 binding'}, 404);
      const cursor = url.searchParams.get('cursor') || undefined;
      const page = await env.bucket.list({cursor, limit: 500, include: ['httpMetadata', 'customMetadata']});
      return exportJson({
        objects: page.objects.map(o => ({key: o.key, size: o.size, etag: o.etag, uploaded: o.uploaded, httpMetadata: o.httpMetadata || {}, customMetadata: o.customMetadata || {}})),
        cursor: page.truncated ? page.cursor : null,
      });
    }
    if (op === 'r2get') {
      if (!env.bucket) return exportJson({error: 'No R2 binding'}, 404);
      const key = url.searchParams.get('key') || '';
      const obj = key ? await env.bucket.get(key) : null;
      if (!obj) return exportJson({error: 'Not Found'}, 404);
      return new Response(obj.body, {headers: {...exportNoStore, 'Content-Type': 'application/octet-stream', 'Content-Length': String(obj.size), ETag: obj.etag}});
    }
    return exportJson({error: 'Unknown op'}, 400);
  } catch {
    return exportJson({error: 'Export failed'}, 500);
  }
}
