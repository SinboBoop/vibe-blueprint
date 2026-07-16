export const CLI_HELP = `Vibe Blueprint CLI

Usage:
  vibe-blueprint auth set
  vibe-blueprint auth status
  vibe-blueprint auth delete
  vibe-blueprint doctor [project_root] [--check-model]
  vibe-blueprint live-verify --yes [--output file]

Commands:
  auth set       Read a Vibe Blueprint model API key from a TTY without echo.
  auth status    Report whether a key is available without revealing it.
  auth delete    Delete current and pre-rename user-level Vibe Blueprint credentials.
  doctor         Check local configuration and an optional project root; add --check-model for a minimal real Responses request.
  live-verify    Explicitly run exact-model and representative real-provider checks; writes only sanitized metadata when --output is set.

API keys are never accepted as command-line arguments.`;
