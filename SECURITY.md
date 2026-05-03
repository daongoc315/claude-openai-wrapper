# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** using [GitHub Security Advisories](https://github.com/daongoc315/claude-openai/security/advisories/new).

- Do **not** open public issues for security reports.
- Include reproduction steps, impact, and affected versions when possible.

Maintainers will acknowledge reports as quickly as possible and coordinate remediation and disclosure.

## Operational safety notes

When running this local OpenAI-compatible wrapper:

- Prefer restrictive `permissionMode` settings.
- Constrain allowed paths with `CLAUDE_OPENAI_ALLOWED_WORKING_DIR_PREFIXES`.
- Do not expose the service to the public internet.
- Set `CLAUDE_OPENAI_API_KEY` if anything besides your own local process can connect.
- Treat enabled tools as local code/file access with the same OS permissions as the wrapper process.
- `bypassPermissions` is rejected unless `CLAUDE_OPENAI_ALLOW_BYPASS_PERMISSIONS=1`; do not enable it outside fully trusted local environments.
- Docker examples bind to loopback by default. If you change them to `0.0.0.0`, use network controls and bearer auth.
