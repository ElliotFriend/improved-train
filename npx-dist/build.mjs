/**
 * Assemble the self-contained npx package under ./vendor.
 *
 * Builds the two workspace packages, then copies their build output + the WASM
 * bundle into ./vendor, mirroring the repo layout so every relative path in the
 * shipped code (../../prover-sidecar/build, ../../static/spp, ../public) still
 * resolves inside the installed package — no code changes, no env overrides.
 *
 * Runs automatically on `npm pack` / `npm publish` via the `prepack` script.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const vendor = resolve(here, 'vendor');

const run = (cmd, args) => {
    console.error(`$ ${cmd} ${args.join(' ')}`);
    execFileSync(cmd, args, { cwd: repo, stdio: 'inherit' });
};

// 1. Build both workspace packages.
run('pnpm', ['--filter', 'mpp-demo-mcp', 'build']);
run('pnpm', ['--filter', 'mpp-demo-prover-sidecar', 'build']);

// 2. Fresh vendor tree.
rmSync(vendor, { recursive: true, force: true });
mkdirSync(vendor, { recursive: true });

// 3. Copy, mirroring the repo layout exactly.
const copies = [
    ['mcp-server/build', 'mcp-server/build'],
    ['prover-sidecar/build', 'prover-sidecar/build'],
    ['prover-sidecar/public', 'prover-sidecar/public'],
    ['static/spp', 'static/spp'],
];
for (const [from, to] of copies) {
    const src = resolve(repo, from);
    const dst = resolve(vendor, to);
    if (!existsSync(src)) throw new Error(`missing build input: ${src}`);
    cpSync(src, dst, { recursive: true });
    console.error(`copied ${from} -> vendor/${to}`);
}

// 4. Sanity-check the entry points the bin + supervisor expect.
const mustExist = [
    'mcp-server/build/index.js',
    'prover-sidecar/build/index.js',
    'prover-sidecar/build/setup.js',
    'prover-sidecar/public/prover.html',
    'static/spp/js/web.js',
];
for (const f of mustExist) {
    if (!existsSync(resolve(vendor, f))) throw new Error(`vendor is missing ${f} after copy`);
}

console.error('vendor/ assembled OK');
