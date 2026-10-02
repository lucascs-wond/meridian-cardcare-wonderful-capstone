# Global tool attachments — decided by the config adapter (2026-08-17)

The agent-config schema DOES support agent-level tool attachments:
`behavior.global_tools` in `config.json` is a map of tool name -> ToolDefinition
("Tool definitions available to all skills (merged at resolve time). Per-skill
entries with the same key override these.").

The 6 agent-level tools are therefore ALREADY ATTACHED GLOBALLY in
`config.json` under `behavior.global_tools`, each as
`{"type": "programmable", "config": {}}`:

- verify-identity
- send-sms-confirmation
- escalate-to-human
- set-eot-delay
- clear-eot-delay
- session-finalize

ACTION FOR THE SKILLS ADAPTER: do NOT re-attach these 6 tools in any
`skills/<skill>/skill.json` `tools` map — they are inherited by every skill via
the global merge. Only attach each skill's own domain tools per-skill. A
per-skill entry with one of these names would OVERRIDE the global definition,
which is not wanted.
