# Contributing

VoiceCan Studio accepts focused changes that preserve its public/private boundary and Capability dependency rules.

1. Read `AGENTS.md`, `studio/AGENTS.md`, and the target Capability guide.
2. Create one focused change; do not commit runtime data, credentials, models, audio, generated `dist/`, or private Device Core material.
3. For a new capability, run `npm run generate:capability -- --name <id>` and register it through its Manifest.
4. Add failure-path tests and update the relevant runbook or AI recipe.
5. Run `npm run verify:change -- --capability <id>` and `npm run ci` before opening a change.

Bug reports should include a redacted reproduction, deployment profile, Node version and relevant error code. Security issues must follow `SECURITY.md`, not the public issue tracker.

By participating, contributors agree to follow `CODE_OF_CONDUCT.md`. Contributions must be their own work or material they are authorized to submit under the repository's eventual license.
