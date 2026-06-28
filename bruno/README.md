# Agent37 Gateway — Bruno collection

API requests for poking the gateway locally, using [Bruno](https://www.usebruno.com/).

## Use it

1. Start the gateway: `npm run prod` (or `npm run dev`) — it listens on `http://localhost:3737`.
2. In Bruno: **Open Collection** → select this `bruno/` folder.
3. Pick the **local** environment (top-right). It sets `baseUrl` to `http://localhost:3737`.
4. Run the requests in order. They chain through env vars:
   - **04 Create Response** saves `session_id` and `responseId`.
   - **05 Continue Session**, **10 Get Session**, **11 Cancel**, **12 Delete**, **15 Rename Session** reuse them.
   - **13 Upload File** writes a file via `PUT /v1/files/content` (raw body) and
     saves `uploadedFilePath`, which **14 Download File** reuses.

There's no auth — the gateway is a localhost service (the host/Docker handles
auth in production), so every request uses `auth: none`.

## Environments

`environments/local.example.bru` is committed; copy it to `environments/local.bru`
(gitignored) if you want a private one. A ready-to-use `local.bru` is included.

## Notes

- **07 Create Response (streaming)** returns Server-Sent Events. Bruno shows the
  assembled stream; for raw frames use `curl -N`.
- The requests default to `reasoning_effort: low` and tiny prompts to keep live
  turns fast and cheap.
