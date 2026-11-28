// Writes dist/server/wrangler.json for deploying the cloud Worker to the
// owner's Cloudflare account. Usage: npm run build && node cloudflare-config.mjs
// Then: wrangler deploy --config dist/server/wrangler.json
//
// Runtime config set separately (wrangler secret put / dashboard):
//   TEACHER_SESSION_SECRET, STUDENT_PORTAL_SECRET, GOOGLE_CLIENT_ID,
//   GOOGLE_CLIENT_SECRET, SUPERADMIN_EMAIL — all stored as Worker secrets so a
//   redeploy never wipes them (wrangler replaces plain vars on every deploy).
import {writeFile} from 'node:fs/promises';

const config = {
  name: 'yennie-cloud',
  main: 'index.js',
  compatibility_date: '2026-05-15',
  workers_dev: true,
  preview_urls: false,
  d1_databases: [{binding: 'DB', database_name: 'yennie-cloud', database_id: 'eaf1baee-571c-42cf-bab4-2533fb5af6dc'}],
  r2_buckets: [{binding: 'BUCKET', bucket_name: 'yennie-cloud-files'}],
  observability: {enabled: true},
  // 04:00 KST daily: delete accounts 30 days after leaving, drop old rollback blobs.
  triggers: {crons: ['0 19 * * *']},
};
await writeFile(new URL('./dist/server/wrangler.json', import.meta.url), JSON.stringify(config, null, 2));
console.log('wrangler.json ->', config.name);
