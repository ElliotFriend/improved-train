# stellar-ai-nurse-mcp

A self-contained, `npx`-runnable build of the [AI Nurse MCP server](../mcp-server).
It bundles everything the patient agent needs — the MCP server, the
[prover sidecar](../prover-sidecar), and the ~22 MB privacy-pool WASM — so a
teammate can wire it into Claude Code without cloning or building anything.

## How it's put together

`build.mjs` builds the two workspace packages and copies their output into
`vendor/`, **mirroring the repo's directory layout**:

```
vendor/
  mcp-server/build/          ← the bin runs this
  prover-sidecar/build/      ← spawned as a child on the first consult
  prover-sidecar/public/     ← prover.html
  static/spp/                ← vendored WASM bundle (served same-origin)
```

That mirror is the whole trick: the MCP server finds the sidecar at
`../../prover-sidecar/build` and the sidecar finds the WASM at `../../static/spp`,
so every relative path resolves unchanged inside the install — no code changes,
no `PROVER_SIDECAR_DIR` / `SPP_STATIC_DIR` overrides needed.

## Build & pack (local / no registry)

```bash
cd npx-dist
node build.mjs            # assemble vendor/ (also runs on `npm pack` via prepack)
npm pack                  # → stellar-ai-nurse-mcp-0.0.1.tgz
```

## Wire into Claude Code

Point `.mcp.json` at the tarball — no local build:

```json
{
    "mcpServers": {
        "ai-nurse": {
            "command": "npx",
            "args": [
                "-y",
                "--package",
                "/abs/path/to/stellar-ai-nurse-mcp-0.0.1.tgz",
                "stellar-ai-nurse-mcp"
            ],
            "env": {
                "MPP_DEMO_BASE_URL": "https://your-nurse-host",
                "PATIENT_STELLAR_SECRET": "S...patient-testnet-secret...",
                "PATIENT_ASP_BLINDING": "0"
            }
        }
    }
}
```

> **Use the `--package <spec> <bin>` form, not `npx -y <tarball>`.** npm 11's npx
> treats a bare tarball path as a local executable and fails with
> `Permission denied`. The `--package` form installs the tarball and then runs
> its named bin. The same applies to a git ref:
> `npx -y --package github:org/repo#subdir stellar-ai-nurse-mcp`. Once it's on a
> registry, plain `npx -y stellar-ai-nurse-mcp` works.

`PROVER_SIDECAR_URL` is unnecessary here — the supervisor spawns the bundled
sidecar on `127.0.0.1:7878` automatically.

## Chromium

The prover runs headless Chromium via Playwright. `playwright` is a dependency,
so its postinstall downloads Chromium (~260 MB) when `npx` first installs the
package. If that's skipped in your environment, the first consult will fail with
a hint to run `npx playwright install chromium`.

## Notes

- The nurse endpoint (`MPP_DEMO_BASE_URL` → `/api/a2a/*`) is a **separate**
  service. This package is only the patient side; point it at a running nurse.
- First consult is slow (Chromium + WASM warm-up + a one-time on-chain deposit
  if the patient is unfunded). Later consults are fast — the browser profile is
  persisted under the package's `prover-sidecar/.prover-profile`.
