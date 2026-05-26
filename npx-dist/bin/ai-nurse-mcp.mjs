#!/usr/bin/env node
/**
 * npx entry point for the AI Nurse MCP server.
 *
 * This package vendors the whole patient side — the MCP server, the prover
 * sidecar, and the WASM bundle — under ./vendor, mirroring the repo's directory
 * layout. That mirror is deliberate: the MCP server finds the sidecar at
 * ../../prover-sidecar/build and the sidecar finds the WASM at ../../static/spp,
 * so all of those relative paths resolve unchanged inside the install.
 *
 * We just hand off to the vendored MCP server entry. It speaks MCP over stdio
 * and supervises the sidecar itself on the first consult.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '..', 'vendor', 'mcp-server', 'build', 'index.js');

await import(pathToFileURL(entry).href);
