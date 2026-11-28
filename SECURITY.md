# Public cloud service security boundary

The original private manager remains separate and owner-only. This service has
no legacy booking proxy, manager service credential, reminder tool, seeded
student data, or connection to the original owner's calendar.

Hosted identity comes exclusively from Sites authenticated identity headers.
No custom password/session system is implemented. Sign-in/out use platform
routes with fixed local return paths. The platform must strip forged identity
headers; the application is never deployed as an unauthenticated raw Worker.

One registered account owns one workspace. All data and file lookups include
that workspace ID, derived server-side from authenticated account membership.
R2 object names begin with the workspace ID. This is logical tenant isolation
in shared D1/R2, not a dedicated physical database/bucket per member.
SUPERADMIN_EMAIL is a server-only runtime secret set to the service owner's
verified account email. It is never accepted from signup, cookies, query
parameters, or a self-reported client role. Admin access to member workspace
and files is audited and disclosed during signup. Suspensions block subsequent
workspace operations; the superadmin cannot suspend itself.

Workspace updates use compare-and-swap revision checks, not last-write-wins.
File uploads are restricted to PNG/JPEG/PDF with signature checks, capped at
10MiB/file, and account storage uses an atomic 100MiB reservation. Files are
served only through authenticated downloads with attachment disposition.
Dynamic content is escaped; CSP forbids inline scripts and third-party scripts.
All responses are private/no-store. Foreign browser origins are rejected.

Tests use three synthetic identities, SQLite transaction fixtures and an
in-memory file bucket. Coverage includes cross-tenant reads/writes/files,
privilege injection, admin visibility/audit, revisions, suspended accounts,
CSRF and unsafe uploads. Production signup and signed-in admin flows require
real ChatGPT authentication and were not completed by the agent.

This initial cloud service includes student/class/notes records, file storage,
backups, registration and account management. Migration of the private app's
calendar, student PIN portal, homework delivery and grading workflows is not
part of this public service version. Existing private app backups can be
explicitly imported; no existing records were copied automatically.

Record store (2026-11-28). Workspace and student-portal data are stored as one
row per record in `doc_records` (doc `w:<workspace>` / `p:<workspace>`), not as
one JSON blob, so a teacher's data is no longer capped by the D1 row size. Every
read and write still resolves the workspace server-side from the signed-in
account. Saves send only changed records with the version they were based on;
a record changed elsewhere first is refused (409) and reported by key, other
records still save. A per-doc revision guard makes each save atomic. The old
blobs (`workspaces.data`, `student_portals.data`) are copied once on first read
and left untouched as a rollback copy.

Backups and errors (2026-11-28). A daily cron (04:00 KST) writes every table
(except short-lived sessions and login counters) to R2 under
`backups/<day>/` as gzip JSON lines with a manifest, kept 30 days. Uploaded
files are already in R2 and are not copied. `/api/admin/ops` (admin site only,
`X-Notice-Key`) shows the last backup and errors and can restore one teacher's
records from a given day (audited). Server errors are counted per day, route
shape and message, with ids removed; no request bodies are kept. D1 Time Travel
remains the whole-database recovery path.
