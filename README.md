# ADVC QA

Web app to browse the QA subtasks of **AdventureCraft › ADVC - What's Left? › QA** on ClickUp
and to file new ones (with screenshots and videos). Every new report is created directly on
ClickUp as a subtask of QA, so ClickUp stays the single source of truth.

## Features

- All QA subtasks, grouped by status, with ClickUp status colours
- Filters by status and assignee, title search, sort by update / creation / priority
- Progress bar with the share of completed subtasks
- Detail panel with description and attachments
- New report form: title, Markdown description, priority, assignees, reporter name,
  images and videos (drag and drop, file picker or paste with Ctrl+V)
- Auto refresh every minute

## Environment variables (Vercel › Settings › Environment Variables)

| Name | Required | What it is |
|---|---|---|
| `CLICKUP_API_TOKEN` | yes | Personal ClickUp token (ClickUp › Settings › Apps › API Token, starts with `pk_`) |
| `APP_PASSWORD` | recommended | Shared team password. Without it anyone with the link can create tasks |
| `BLOB_READ_WRITE_TOKEN` | for videos over 4 MB | Set automatically when you connect a Vercel Blob store to the project |
| `QA_PARENT_TASK_ID` | no | Defaults to `123n15he40e` (QA) |
| `QA_LIST_ID` | no | Defaults to `901523125199` (ADVC - What's Left?) |

The token stays on the server: the browser only calls the app's own `/api/*` routes.

### Large videos

Vercel functions accept request bodies up to about 4.5 MB. Files up to 4 MB go straight
through the API. Bigger files are uploaded from the browser to Vercel Blob, then the server
forwards them to ClickUp and deletes the temporary copy. To enable it: Vercel project ›
Storage › Create › Blob › connect to the project, then redeploy.

## Local development

```bash
cp .env.example .env.local   # fill in CLICKUP_API_TOKEN
npm install
npm run dev
```
