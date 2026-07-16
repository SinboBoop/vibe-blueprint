# Vibe Blueprint security model

Vibe Blueprint handles repository metadata, technical-foundation decisions, Git diffs, and access to an external model. Its controls reduce unnecessary exposure; they do not turn an MCP client or a repository into a trusted execution environment.

## Credential lifecycle

Use a key that belongs to the installing user. Vibe Blueprint never bundles a key and must not read `~/.codex/auth.json` or reuse a host client's credentials.

Set a workstation credential only through an interactive TTY:

```bash
vibe-blueprint auth set
```

The prompt does not echo input. The key is written atomically to `${FOUNDATION_CONFIG_DIR}/credentials.json` when that explicit override is set; otherwise new credentials use the platform user-config directory under `vibe-blueprint` (normally `$XDG_CONFIG_HOME/vibe-blueprint/credentials.json` on Unix-like systems, with the platform application-data fallback on Windows). The directory is restricted to mode `0700` and the file to `0600` on platforms that support POSIX permissions. The CLI rejects a key passed as a command-line argument so it cannot be captured in shell history or a process listing.

For users of the pre-release name, reads also check the former `foundation-guard/credentials.json` user-config location only when the new credential is absent. The fallback is local and read-only during discovery: it does not print, copy into the repository, or silently expose the key. A new credential takes precedence, and `auth status` reports the source without revealing the value. `FOUNDATION_CONFIG_DIR` remains the explicit override contract and is not combined with default-path fallback.

Inspect presence without revealing the value, and delete it when rotating or uninstalling:

```bash
vibe-blueprint auth status
vibe-blueprint auth delete
```

`FOUNDATION_LLM_API_KEY` has highest precedence and is appropriate for a secret manager or ephemeral process environment. Do not place it in `.env`, MCP JSON/TOML, logs, test fixtures, bug reports, or chat. The repository ignores common credential files, while `.env.example` contains only a placeholder.

`vibe-blueprint auth delete` removes both the current default credential file and the pre-rename fallback file when they exist. It cannot remove a credential injected by the process environment or an external secret manager.

Vibe Blueprint redacts `Authorization` values, bearer tokens, and key-shaped strings from model/provider errors, diagnostics, evidence output, and persisted endpoint-probe results. Still treat any unexpected error report as sensitive until reviewed.

## External model requests

The default endpoint and model settings are:

```text
base URL: https://api.inferenvoy.com
wire API: OpenAI Responses
model: gpt-5.6-sol
reasoning effort: xhigh
store: false
```

The model ID, base URL, Responses path, and reasoning effort are environment-overridable. The exact configured model is preserved on errors; Vibe Blueprint does not silently fall back to a different model. `store: false` is requested, but the endpoint operator's own infrastructure and policies remain outside this project's control.

`vibe-blueprint live-verify --yes` is an explicit, default-off release check and never runs during ordinary tests. If `--output` is provided, it persists only fixed, sanitized verification metadata. It excludes credentials, headers, requirements, prompts, raw model output, facts, recommendation text, and repository material by schema.
Measured `xhigh` strict structured analyses through the configured relay can take roughly one to four minutes. Foundation model requests therefore use a 600-second hard timeout, and client examples give the MCP tool a 660-second window so the server can return its own sanitized timeout result. The opt-in live release check uses the same per-request ceiling. This is a ceiling, not a latency target; Doctor's minimal model probe usually returns much sooner.

Choose how much repository context may leave the machine:

| Mode | Model-bound repository context |
| --- | --- |
| `none` | No caller-supplied repository summary, source, or Git diff. |
| `summary` | A supplied plain structural summary may be included after redaction and size checks; code-like dumps are rejected. |
| `diff` | Supplied diff added lines may be included after sensitive-file filtering, redaction, and a size limit. |

The user's requirement and committed project-foundation facts needed for reassessment are sent when analysis is requested. Remove secrets and unnecessary personal data from requirements too. Common sensitive files, `.env` variants, credentials, private keys, Git internals, dependency/install directories, and build output are excluded from repository-context collection regardless of sharing mode.

Repository content is data, not instructions. The model prompt isolates and labels repository-derived text to resist prompt injection, and deterministic validation and decision filtering run after the model returns structured JSON. Prompt-injection defenses reduce risk but cannot guarantee that untrusted content has no influence.

## Filesystem boundary

Every tool canonicalizes `project_root` with `realpath` and verifies it is inside a component-aware `FOUNDATION_ALLOWED_ROOTS` entry. This prevents lexical `..`, prefix confusion, and symbolic-link escapes. Multiple roots use the platform path delimiter. When the variable is unset, only the server's current working directory is allowed. Configure the narrowest practical root and run `foundation_doctor` to verify it before use.

State writes use an atomic temporary-file replacement so a crash is less likely to leave partial JSON. `foundation_commit` writes project-foundation artifacts only and never application source.

## Git scanning

Diff scanning looks for independent signals across staged, tracked-unstaged, and ordinary untracked source changes, plus dependencies, migrations, environment-variable names, structure, and content. It reads worktree files directly with `O_NOFOLLOW` and does not invoke repository clean/text-conversion filters. A single ambiguous keyword cannot create a high-confidence block; high confidence requires two independent signals or one unusually explicit piece of evidence. This avoids treating comments or incidental wording as proof of payment, tenancy, offline sync, or sensitive-data behavior.

Diffs are local unless `FOUNDATION_CODE_SHARING=diff` is explicitly configured. Even then, collection is redacted and size-limited before a model request.

## Evidence command execution

`foundation_verify` is not an arbitrary command runner. It can execute only commands explicitly recorded in the committed Foundation and admitted by the executable/argument allowlist. Commands are launched with arguments separated, `shell: false`, a timeout, an output cap, and a controlled working directory. Because `npm run` and similar package managers internally invoke their own shell, registration stores a SHA-256 binding over the reviewed `pre`/main/`post` package-script definitions; preview and run both fail closed if any definition changes. Results are redacted before they are saved with the Git commit, Foundation revision/source hash, and timestamp.

Preview evidence checks before running them when the Foundation changed or the repository is untrusted.

## Minimum-invariant boundary

The current runtime registry contains five deliberately small invariant families: authoritative production records, offline continuity, multi-organization isolation, real payments, and sensitive data. Deterministic code can reject a route whose selected pattern conflicts with the required family or whose structured result omits a required invariant ID.

This is an input-completeness and contradiction gate, not implementation evidence. The structured invariant IDs initially come from the model-authored candidate route; checking that the complete required set is present does not prove that source code implements it. The registry also contains no technology catalog, vendor verification, jurisdiction policy, penetration test, or production-readiness certification. Until a catalog exists, strict output validation rejects exact versions, prices, and absolute vendor-capability promises and requires a compatibility range or install-time latest-stable wording instead. Verify each safeguard through design review, implementation review, registered evidence checks, and appropriate specialist review before relying on it.

## MCP transport and logs

The MCP server uses stdio. Stdout is reserved exclusively for JSON-RPC/MCP protocol data; all diagnostics go to stderr. Avoid debug wrappers that print banners to stdout. An MCP client controls when tools are exposed and invoked, so review that client's own trust, approval, and logging settings as well.

## Enforcement boundary

Saved project-foundation state and the thin Skill guide agent behavior but are not, by themselves, an access-control system.

Vibe Blueprint reduces the probability of silent architecture-boundary crossing; only hooks, CI, and protected branches make selected rules technical blockers.

For higher assurance, turn selected scans and evidence checks into CI requirements, protect the release branch, and use client hooks or policy controls for the operations that must be blocked mechanically.

## Reporting a vulnerability

Do not open a public issue containing credentials, private source, raw diffs, or unredacted logs. Use the repository's [private vulnerability reporting form](https://github.com/SinboBoop/vibe-blueprint/security/advisories/new) and provide a minimal, redacted reproduction.
