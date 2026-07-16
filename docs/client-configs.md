# Vibe Blueprint MCP client configuration

Build and link Vibe Blueprint first, then obtain the absolute executable path with `command -v vibe-blueprint-mcp`. Replace every placeholder below. Do not rely on shell expansion such as `$HOME` inside a client configuration.

These examples deliberately include only non-sensitive settings. Run `vibe-blueprint auth set` in an interactive terminal instead of putting `FOUNDATION_LLM_API_KEY` in JSON, TOML, command history, or client logs.

Set `FOUNDATION_ALLOWED_ROOTS` to the narrowest directory containing the projects the server may access. Every `project_root` is resolved with `realpath`; a textual path that escapes through `..` or a symbolic link is rejected.

## Client compatibility

The Decision Integrity contract preserves all eight `foundation_*` MCP tool names and project-foundation state schema version 1. It adds `abstain` as a fifth valid `interaction_mode` and adds activity-risk, route-elimination, and minimum-invariant trace fields to decision results.

Clients with an exhaustive four-mode switch must add this behavior before upgrading:

- treat `abstain` as a successful MCP response in which no route was selected;
- show `abstention_reason`, `abstention_detail`, and `recovery` faithfully;
- ask only a non-null `recovery.question` returned by Vibe Blueprint;
- do not reinterpret abstention as `escalate`, a transport failure, or permission for the host model to choose a route; and
- tolerate additive trace fields without requiring them on historical non-abstaining payloads.

The five minimum invariant families are narrow completeness checks, not production certification. A passing trace does not authorize a client to claim that safeguards are implemented, that a technology has been independently verified, or that compliance review is complete. See the [Decision Integrity release notes](releases/decision-integrity.md) for the supported boundary.

## Codex

Current Codex clients share MCP configuration from `~/.codex/config.toml`. Register the stdio server with the CLI:

```bash
codex mcp add vibe_blueprint \
  --env FOUNDATION_LLM_BASE_URL=https://api.inferenvoy.com \
  --env FOUNDATION_LLM_MODEL=gpt-5.6-sol \
  --env FOUNDATION_LLM_REASONING_EFFORT=xhigh \
  --env FOUNDATION_CODE_SHARING=none \
  --env FOUNDATION_ALLOWED_ROOTS=/absolute/path/to/projects \
  -- /absolute/path/to/vibe-blueprint-mcp
```

Check registration without displaying any credential:

```bash
codex mcp list
```

Alternatively, add this table to `~/.codex/config.toml` while preserving every existing setting:

```toml
[mcp_servers.vibe_blueprint]
command = "/absolute/path/to/vibe-blueprint-mcp"
args = []
startup_timeout_sec = 10
tool_timeout_sec = 660

[mcp_servers.vibe_blueprint.env]
FOUNDATION_LLM_BASE_URL = "https://api.inferenvoy.com"
FOUNDATION_LLM_MODEL = "gpt-5.6-sol"
FOUNDATION_LLM_REASONING_EFFORT = "xhigh"
FOUNDATION_CODE_SHARING = "none"
FOUNDATION_ALLOWED_ROOTS = "/absolute/path/to/projects"
```

Back up `config.toml` before editing it manually. Do not change the top-level Codex `model` or `model_provider`; `gpt-5.6-sol` is used inside Vibe Blueprint, not as the Codex host model. Restart the Codex app/extension or start a new task after changing the configuration. In Codex CLI, `/mcp` shows active servers.

To unregister:

```bash
codex mcp remove vibe_blueprint
```

## Claude Code

Add a project-scoped `.mcp.json` or the equivalent user-scoped configuration:

```json
{
  "mcpServers": {
    "vibe_blueprint": {
      "type": "stdio",
      "command": "/absolute/path/to/vibe-blueprint-mcp",
      "args": [],
      "env": {
        "FOUNDATION_LLM_BASE_URL": "https://api.inferenvoy.com",
        "FOUNDATION_LLM_MODEL": "gpt-5.6-sol",
        "FOUNDATION_LLM_REASONING_EFFORT": "xhigh",
        "FOUNDATION_CODE_SHARING": "none",
        "FOUNDATION_ALLOWED_ROOTS": "/absolute/path/to/projects"
      }
    }
  }
}
```

If `.mcp.json` is committed, ensure the allowed-root value is portable for the team or keep this registration user-scoped. Never add an API key. Restart Claude Code after changing MCP configuration and confirm that all eight `foundation_*` tools are listed.

## Cursor

Add the server to the user or project `mcp.json` supported by your Cursor version (commonly `~/.cursor/mcp.json` for user configuration):

```json
{
  "mcpServers": {
    "vibe_blueprint": {
      "type": "stdio",
      "command": "/absolute/path/to/vibe-blueprint-mcp",
      "args": [],
      "env": {
        "FOUNDATION_LLM_BASE_URL": "https://api.inferenvoy.com",
        "FOUNDATION_LLM_MODEL": "gpt-5.6-sol",
        "FOUNDATION_LLM_REASONING_EFFORT": "xhigh",
        "FOUNDATION_CODE_SHARING": "none",
        "FOUNDATION_ALLOWED_ROOTS": "/absolute/path/to/projects"
      }
    }
  }
}
```

Restart Cursor or reload its window, then inspect MCP settings to confirm the server started and exposed eight tools.

## Other stdio clients

Use the same process contract:

- command: the absolute `vibe-blueprint-mcp` executable path
- arguments: none
- transport: stdio
- working directory: any stable existing directory
- stdout: MCP protocol only
- environment: the non-secret values shown above

The server logs to stderr. If the client sanitizes its inherited environment, the user credential file still works; otherwise, `FOUNDATION_LLM_API_KEY` may be injected by a proper secret manager and takes precedence. Never store the key in a checked-in configuration.

## Multiple project roots

Separate multiple roots with the platform path delimiter (`:` on macOS/Linux, `;` on Windows), or register separate narrowly scoped server entries when projects live in unrelated roots. If unset, only the server's current working directory is allowed. Confirm the parsed roots with `foundation_doctor` before analysis. Narrow roots reduce the impact of a mistaken or malicious tool request.

## Responses endpoint overrides

The default base URL is `https://api.inferenvoy.com`. With no `FOUNDATION_LLM_RESPONSES_PATH`, the first real structured analysis or `check_model` connectivity request posts to `/responses`; only an HTTP 404/405 causes a retry at `/v1/responses`. After an HTTP-successful response, Vibe Blueprint caches only the base URL, path, and check time in the user config directory. Authentication, model, schema, and other provider failures are reported instead of triggering a path or model fallback. To force a provider-specific path, add for example:

```text
FOUNDATION_LLM_RESPONSES_PATH=/responses
```

Do not silently change `FOUNDATION_LLM_MODEL` if the provider rejects `gpt-5.6-sol`; preserve the configured ID and report the provider's redacted error.

## Compatibility with the pre-release executable

New installations should use the `vibe_blueprint` client key and `vibe-blueprint-mcp` executable shown above. Existing local registrations that still point to the temporary `foundation-guard-mcp` compatibility alias continue to start the same server; remove the old registration and add the new one when convenient. Do not register both names at once, because that would expose the same eight tools twice.
