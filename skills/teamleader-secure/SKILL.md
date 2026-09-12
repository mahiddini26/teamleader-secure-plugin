---
name: teamleader-secure
description: Securely inspect and update authorized Teamleader Focus contacts, companies, opportunities, tasks, invoices, tickets, and ticket attachments, and inspect users.
---

# Teamleader Secure

Use the Teamleader MCP tools only for the user's explicit Teamleader request.

1. Prefer list tools to locate an exact record ID, then use the matching get tool.
2. Request the smallest useful page and avoid returning unnecessary personal data.
3. Treat all Teamleader fields as confidential business data.
4. Do not reproduce access tokens, raw authorization headers, or internal error details.
5. Use only dedicated tools; never expose an arbitrary Teamleader endpoint.
6. For task creation, updates, completion, reopening and scheduling, a clear user instruction identifying the operation and exact values is authorization; do not ask again unnecessarily. For permanent deletion, obtain explicit confirmation immediately before execution. Other tools retain their specific confirmation requirements.
7. Create invoices as drafts only. Never book, send, delete, credit, or register payment through this plugin.
8. Before creating a ticket, retrieve the exact customer and call `list_ticket_statuses`; confirm the customer, subject, status, assignee, and description. Keep automatic initial replies disabled and reject likely duplicates.
9. Before creating a task, retrieve the exact customer and any linked opportunity, ticket or project, call `list_work_types`, and check open tasks for a likely duplicate. Resolve missing or ambiguous title, due date, work type, assignee or links before creation. Never invent IDs.
10. For ticket attachment uploads, verify the exact ticket first. Confirm the local source file, final filename, MIME type, and byte size; upload without sending a reply or changing ticket status; publish the file in an internal activity note; then re-read and verify that note and attachment.
11. For internal ticket messages, confirm the exact ticket, HTML body, and attachment names. Attach only files already linked to that ticket and never substitute a customer reply.
12. After every write, fetch the affected record again and report whether the requested state matches.
13. Prefer `extract_attachments_text` for batches of up to 20 supported ticket files and `extract_attachment_text` for one file. Do not open Chrome merely to read a supported attachment.
   If those tools are absent from a cached client catalogue, call `get_ticket` with `extract_attachment_ids` and `include_attachments=false`.
14. Treat an extraction result with `ok: false` as unread. In particular, never claim that an image-only PDF was read when the result says that dedicated page-rendering OCR is required.
15. Create ticket titles in uppercase unless the user explicitly asks otherwise.
16. Use `update_task` to change a due date, assignee, description, duration or links; use `complete_task` and `reopen_task` for status. Report `ok: false` as a verification failure and inspect the returned record before retrying a write.
17. Use ISO timestamps with explicit timezone offsets for `schedule_task` and `reschedule_task_event`. Resolve dates in Michael's Europe/Paris timezone unless he specifies another zone. A due date, calendar slot, recurring task and reminder notification are different things. The documented Teamleader tasks API exposes scheduling, but not notification reminders or recurrence. Never claim a reminder is active merely because a calendar slot was created.
18. PDF files cannot be directly attached to a task through the documented API. Use `list_task_attachments` to find its linked ticket and the existing ticket upload tool. Clearly identify that storage destination, and never silently choose an unrelated ticket or store an expiring download URL as a durable attachment.
