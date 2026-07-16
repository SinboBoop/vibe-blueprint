# Security Policy

## Current reporting status

The source repository is public. The npm package has not been published yet, so source checkouts from the `main` branch are the currently supported distribution.

Do not put credentials, exploit details, sensitive logs, or other security-sensitive information in a public issue.

## Private reporting

Report a suspected vulnerability through the repository's [private vulnerability reporting form](https://github.com/SinboBoop/vibe-blueprint/security/advisories/new), or open the repository's **Security** tab and choose **Report a vulnerability**. GitHub Security Advisories keep the report private between the reporter and repository maintainers while it is investigated.

The active repository is <https://github.com/SinboBoop/vibe-blueprint>. If the private reporting option is unavailable, please do not disclose sensitive details in a public issue.

Public issues may be used for non-sensitive security questions or hardening suggestions that do not reveal an exploitable weakness.

## What to include

Include:

- the affected version or commit;
- the environment and configuration needed to reproduce the issue;
- a minimal reproduction and the expected security impact; and
- whether credentials or real user data may have been exposed.

Remove live API keys, tokens, and personal data from all attachments. Maintainers will coordinate remediation and disclosure through the advisory. No fixed response-time commitment is currently made.

## Scope clarification

Useful reports include credential exposure, unsafe file access, command execution, authentication-boundary failures, and vulnerabilities in the MCP or CLI implementation. Disagreement with an architecture recommendation, or a limitation already documented as not being a security or compliance audit, is usually a product-quality issue rather than a software vulnerability.
