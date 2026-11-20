# YENNIE SENSE

Read `HANDOFF.md` first: it describes the three sites (booking, manager, cloud), their Cloudflare resources, secrets (names only), auth, integrations, and deploy steps.

- `main` is production on Cloudflare Workers. `sites-*` branches are the retired ChatGPT Sites history; do not deploy them.
- Keep the existing admin UI and flows unless the owner asks for a UI change. Never test with real student data or real notifications.
- Report status as: source exists / tests pass / production deploy verified / real data migrated.
- Store every runtime value as a Worker secret (plain vars are wiped by `wrangler deploy`).
