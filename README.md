# PDF folder listener

Requires Node.js 22.22.2+, 24.15+, or 26+ for SQLite and desktop notifications.
No database server to install. Install the PDF reader dependency once:

```powershell
npm install
```

Run from this project folder:

```powershell
npm start
```

Settings are loaded from `.env` in this project folder, even when starting Node
from another directory. The existing token has been moved there. For a fresh
installation, copy `.env.example` to `.env` and set `API_TOKEN`.
Example folder mapping:

```dotenv
API_URL=http://127.0.0.1:8001/api/v1/requests/from-pdf
API_TOKEN=YOUR_API_TOKEN
RETRY_DELAY_SECONDS=30
DESKTOP_NOTIFICATIONS=true
TEMPLATE_ID=5
DEPARTMENT_ID=2

WATCH_FOLDER_1='C:\Users\Aria Ysabelle\Desktop\po\elbert'
USER_ID_1=6

# Optional second folder with its own preparer and template:
# WATCH_FOLDER_2='C:\Users\Aria Ysabelle\Desktop\po\another-person'
# USER_ID_2=7
# TEMPLATE_ID_2=5
# DEPARTMENT_ID_2=3
```

For each `WATCH_FOLDER_n`, set `USER_ID_n` to the person who prepared PDFs in that
folder. `TEMPLATE_ID` is the default; `TEMPLATE_ID_n` overrides it for one folder.
`DEPARTMENT_ID` sets the default department sent as `department_id` in every API
POST. Use `DEPARTMENT_ID_n` to override it for a particular folder. Department IDs
must be positive integers. The initial value `2` matches the department returned
by the earlier successful request; change it to the appropriate department.
Use absolute paths and keep Windows paths single-quoted as shown. Duplicate
folder paths and invalid IDs are rejected at startup. Command-line folder
overrides are no longer supported, to avoid assigning the wrong preparer.
Restart the listener after editing `.env`. Existing process environment variables
take precedence over `.env` values. The old `api.config.json` is no longer used.

The listener checks the folders between processing cycles and logs existing, new, and updated
PDF files after their size and timestamps have stayed unchanged for two seconds.
This is a heuristic for copy completion; a paused transfer can appear stable.
Only files directly inside the folder are included. The `.pdf` extension is
case insensitive; file contents are not validated. Each file version is reported
once per run. Restarting reports existing PDFs again.

Each detected PDF is saved to `data/listener.db` inside this project. The folder,
database, and `pdf_files` table are created automatically on startup.
The table stores `id`, `filename` (including `.pdf`), `file_path`, and
`detected_at` (first detection time in UTC). The full path is unique, so restarting
the listener or updating a PDF does not create duplicate rows. Files with the
same name in different watched folders have separate rows. Records are retained
when PDFs are deleted. PDF contents are not stored.

To view saved filenames using a SQLite database viewer, open `data/listener.db`
and run:

```sql
SELECT filename FROM pdf_files ORDER BY id;
```

The listener uploads each PDF as multipart form data to `API_URL` in
`.env`, using Bearer authentication, the folder's `user_id`, `template_id`, and `department_id`,
`document_title`, and `attached_pdf`. The local configuration contains your token and is ignored
by Git; use `.env.example` when setting up another copy.
The configured template is `5` (Purchase Order). `user_id` identifies the person
who prepared the document; it is currently `6`. Restart the listener after
changing the configuration. Updating the mapping does not resubmit previously
recorded successful uploads. Failed requests use the current folder mapping when retried.

The listener reads selectable text from the first PDF page using Mozilla PDF.js.
It locates the Date, P.O. No., Vendor, and Ship To cells in the Purchase Order
layout shown in the examples. The expected delivery date is not used as the
document date. Image-only scans need OCR and are currently retained for review.

Additional multipart fields for the backend to accept and store:

| Field | Example |
| --- | --- |
| `po_no` | `31164` |
| `vendor` | `Coca-Cola Europacific Philippines, Inc.` |
| `document_date` | `2026-10-22` |
| `ship_to` | `Tagum 7 Pag Asa` |
| `document_title` | `31164-Coca-Cola Europacific Philippines, Inc.` |

The `attached_pdf` upload filename is `{po_no}-{vendor}.pdf`, with Windows-invalid
characters replaced by underscores and trailing periods removed before `.pdf`.
For this example it is `31164-Coca-Cola Europacific Philippines, Inc.pdf`.
The original file on disk keeps its name until successful upload and deletion.
No uniqueness hash is appended to the title; duplicate-title validation is the
backend's responsibility.

Extracted fields, title, and upload filename are stored as JSON in
`pdf_uploads.po_metadata`. If a required field cannot be extracted or the date is
invalid, the record is marked `parse_failed` and the PDF is retained without an
API call. Fix the PDF (changed contents create a new attempt), or after fixing
the parser, stop the listener and remove only the relevant `parse_failed` row to
try again. Local history never permanently blocks submission of a readable PDF;
the backend is responsible for validation and duplicate-title detection.

The `pdf_uploads` table records each path/content version, status, HTTP response,
and upload/deletion timestamps. A confirmed successful JSON response is saved
before the PDF is deleted. A changed file is retained. Cleanup failures retry
without uploading again. If identical content returns to the same path after
successful deletion, the listener submits it to the API again. A fresh explicit
duplicate-title response allows deletion; if the request no longer exists, a
successful creation allows deletion. Other failures retain the file. The latest
attempt replaces the old local result for that path and content hash. The backend
must enforce title uniqueness to prevent duplicate requests.

Rejected uploads (HTTP 4xx) are marked `failed` and automatically retried every
`RETRY_DELAY_SECONDS` (default 30) until successful. The next retry time is saved
in SQLite and respected after restarting. Existing failed rows without a retry
time are eligible immediately. Fix backend validation or permissions and the
next attempt will use those changes; no database reset is needed.

Exception: if the API explicitly reports that `document_title` already exists
with HTTP 409 or 422, the listener records `duplicate` and deletes the unchanged
PDF instead of retrying. It recognizes a duplicate message in
`errors.document_title`, a message naming the document title, or the code
`document_title_exists` / `duplicate_document_title`. Other validation errors
and generic conflicts do not trigger deletion. Duplicate cleanup uses the same
file-change checks as successful uploads and does not show a request-created
notification.

Network errors, server errors, and ambiguous responses are marked `uncertain`
and retried after `RETRY_DELAY_SECONDS`. Existing local records, including
interrupted uploads, do not block submission after restarting. SQLite records
results and retry timing; the backend must enforce unique document titles,
including retries after timeouts. If a prior attempt created the request, the
backend's explicit duplicate-title response allows the local PDF to be deleted.

If the API rejects `template_id`, configure that template's approval path,
signature placements, and active approvers in the backend first.

If the folder is unavailable, the listener keeps checking until it becomes
available. Press Ctrl+C to stop. Logs appear in the terminal.

After the API confirms creation and SQLite saves the result, a desktop
notification shows "E-sign request created", the document title, and the request
reference when returned by the API. Cleanup retries and restarts do not repeat
notifications for previously created requests. Notification failures are logged
and do not interrupt PDF deletion or trigger another API call. Notifications
are best effort; a process crash between saving success and showing the toast
can prevent one from appearing.

Set `DESKTOP_NOTIFICATIONS=false` in `.env` to disable them, then restart.
Run the listener as the logged-in desktop user. Windows must allow notification
banners and sounds; Do Not Disturb may suppress banners. The bundled notification
helper may appear as "SnoreToast" in Windows notification settings.

Test notifications without uploading a PDF:

```powershell
npm run notify:test
```

If a toast banner does not appear, open Windows Settings > System > Notifications,
turn Do Not Disturb off, and enable notifications, notification banners, and
Notification Center entries for SnoreToast. The helper's "submitted" or "timeout"
result does not prove that Windows displayed a banner.

To try the Windows tray notification helper instead:

```powershell
npm run notify:test -- balloon
```

Set `DESKTOP_NOTIFICATION_MODE=balloon` in `.env` to use that helper for future
requests; `toast` is the default. Both methods remain subject to Windows settings.
