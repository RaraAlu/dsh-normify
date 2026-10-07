# Normify for Codex

[简体中文](README.md) | English

Version 0.6.0 provides a standalone local Codex MCP server, 31 architecture tools,
and the `normify-gen` / `normify-dev` skills. No DSH host or separate adapter checkout is required.
The original engine, data format, validation, receipts, and interactive HTML renderer remain intact.

## One-click installation

Install Node.js 22+ with npm and the Codex CLI first. The installer finds native Codex binaries
and standard npm-installed Codex launchers automatically. The tested CLI version is 0.146.0.

```sh
git clone https://github.com/RaraAlu/dsh-normify.git
cd dsh-normify
```

On Windows, double-click `install.cmd`, or run:

```powershell
.\install.ps1
```

On macOS/Linux:

```sh
sh install.sh
```

The bootstrap installs locked dependencies with lifecycle scripts disabled, builds the engine,
checks its contract, verifies all 31 tools over stdio, backs up user configuration and managed skills,
then registers the MCP server and installs both skills. Start a new Codex session afterward.
Keep this checkout and Node.js at their installed paths: the MCP command uses absolute paths.

The installer preserves unrelated servers, refuses unmanaged or user-modified skills,
and never overrides a disabled Normify server. Failed registration restores configuration and skills.
Backups live under `backups/normify-codex/` in the Codex configuration directory.

To explicitly migrate an unchanged managed installation from another checkout, use
`.\install.ps1 --migrate` or `sh install.sh --migrate`. Migration preserves the previous storage root.
It does not migrate or trust reminder hooks. A moved checkout also needs migration.

Optional installer flags: `--codex-executable`, `--codex-home`, `--skills-root`, and `--storage-root`.
`CODEX_CLI_PATH` can supply the CLI path. Configuration defaults to `CODEX_HOME` or `~/.codex/`;
data defaults to its `normify/` subdirectory; skills default to `~/.agents/skills/`.
A custom skills root changes the copy destination only; Codex must discover that directory separately.

## Usage

Use `$normify-gen` to generate architecture and `$normify-dev` for governed development.
The MCP server name is `normify`. Call `normify_help` for schemas and workflows.
Pass an absolute `repoRoot` for source evidence. Select a storage project with `project`,
or pass an absolute `dir` whose basename begins with `normify-`.

Architecture-only requests do not authorize source changes. Validation does not replace product tests.
Never fabricate fingerprints or acceptance evidence. Errors block compilation; report warnings too.
Outputs include `tree.json`, `outline.md`, `api-index.json`, `receipt.json`, and `normify.html`.

```sh
npm run verify:codex
node src/stdio.mjs --root /absolute/storage --read-only
```

Verification checks actual Codex discovery of both skills and 31 tools without calling a cloud model.
Its report lives in `reports/`. Verification disables unrelated integrations only in its own process.

## Optional reminder hooks

Review the hook source first, run `npm run install:hooks`, and trust the hook in Codex `/hooks`.
After reviewing the exact definition, `npm run install:hooks -- --trust-installed` can trust that hash.
The installer never enables a disabled native hooks feature.

The reminder counts eight successful edits per session and repository. It does not edit source or architecture,
watch external file saves, or count shell writes. It is not an automatic acceptance gate.
Source changes require another review and installation.

## Development

```sh
npm ci --ignore-scripts
npm run build
npm run typecheck
npm run check
npm test
npm pack --dry-run
```

Tests isolate their storage and Codex configuration. Native installation/hook tests skip explicitly
when Codex is unavailable. The hook fixture serves deterministic local responses, not a cloud model.
CI covers Windows/Linux and Node.js 22/24. Historical DSH documents describe older releases;
the current README and source define the Codex integration.

[MIT](LICENSE), original author yan-mc. See [security](SECURITY.md) and [contributing](CONTRIBUTING.md).
