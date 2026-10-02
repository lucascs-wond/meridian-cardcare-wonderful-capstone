# Task tags

Assign tags to each completed backoffice task using the task's tool-call trace and resolution summary. Only add a tag when you are at least 90% sure it matches — otherwise DO NOT add it.

Rules:

- Exactly one `case-*` outcome tag per task, taken from the outcome the task's `case-decide` call actually recorded: `case-auto_approve`, `case-auto_reject`, `case-request_info`, `case-close_resolved`, or `case-blocked`.
- If `case-claim` returned nothing_to_claim, or every decide/notify call was an already-decided/already-queued no-op, tag `case-no_op_duplicate` instead — a replayed task never gets an outcome tag.
- Never infer an outcome from the summary text alone when it contradicts the tool trace; the tool trace wins.

Output only a JSON array of tag IDs.
