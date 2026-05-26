/**
 * Prover-sidecar supervisor.
 *
 * The MCP server is the one process Claude Code starts automatically (via
 * `.mcp.json`). The privacy-pool prover lives in ../../prover-sidecar and used
 * to be a separate process the user had to `bootstrap` + `start` by hand. This
 * module folds that lifecycle into the MCP server: on the first consult we
 *
 *   1. health-check the sidecar URL — if it's already up (someone ran it
 *      manually), use it as-is and we're done;
 *   2. otherwise spawn `prover-sidecar/build/index.js` as a child process,
 *      inheriting the patient env, and wait for /health to go green;
 *   3. if the patient has no spendable notes, run the one-time bootstrap
 *      (`setup.js`: derive keys, register ASP, deposit) and wait for the
 *      indexer to surface them.
 *
 * The result is memoized, so this whole dance happens once per MCP-server
 * lifetime. The child is killed when we exit.
 *
 * Auto-start needs PATIENT_STELLAR_SECRET in the MCP server's env (it gets
 * forwarded to the child). If the secret is absent we only support an
 * already-running sidecar — set PROVER_SIDECAR_AUTOSTART=0 to require that.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface SidecarConfig {
    sidecarUrl: string;
    /** Directory holding the built sidecar (index.js + setup.js). */
    sidecarDir: string;
    /** When false, never spawn — require an already-running sidecar. */
    autoStart: boolean;
    /** How long to wait for a freshly-spawned sidecar to report healthy. */
    bootTimeoutMs: number;
    /** How long to wait for notes to surface after a bootstrap deposit. */
    fundTimeoutMs: number;
}

interface HealthBody {
    ok: boolean;
    address: string;
    notes: number;
    unspentStroops: string;
}

export function buildSidecarConfig(env: NodeJS.ProcessEnv): SidecarConfig {
    const sidecarUrl = (env.PROVER_SIDECAR_URL ?? 'http://127.0.0.1:7878').replace(/\/$/, '');
    const sidecarDir =
        env.PROVER_SIDECAR_DIR ?? resolve(HERE, '..', '..', 'prover-sidecar', 'build');
    return {
        sidecarUrl,
        sidecarDir,
        autoStart: env.PROVER_SIDECAR_AUTOSTART !== '0',
        bootTimeoutMs: Number(env.PROVER_SIDECAR_BOOT_TIMEOUT_MS ?? '180000'),
        fundTimeoutMs: Number(env.PROVER_SIDECAR_FUND_TIMEOUT_MS ?? '90000'),
    };
}

const log = (msg: string) => console.error(`[sidecar-supervisor] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function health(sidecarUrl: string, timeoutMs = 2500): Promise<HealthBody | null> {
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        const res = await fetch(`${sidecarUrl}/health`, { signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) return null;
        return (await res.json()) as HealthBody;
    } catch {
        return null;
    }
}

let child: ChildProcess | null = null;
let cleanupRegistered = false;

function spawnSidecar(cfg: SidecarConfig): void {
    const entry = resolve(cfg.sidecarDir, 'index.js');
    if (!existsSync(entry)) {
        throw new Error(
            `prover-sidecar build not found at ${entry} — run ` +
                '`pnpm --filter mpp-demo-prover-sidecar build` (or set PROVER_SIDECAR_DIR).',
        );
    }
    if (!process.env.PATIENT_STELLAR_SECRET) {
        throw new Error(
            'PATIENT_STELLAR_SECRET must be set in the MCP server env (e.g. in .mcp.json) ' +
                'to auto-start the prover sidecar. Alternatively start the sidecar yourself ' +
                'and set PROVER_SIDECAR_AUTOSTART=0.',
        );
    }
    const port = new URL(cfg.sidecarUrl).port || '7878';
    log(`spawning prover sidecar: node ${entry} (port ${port})`);
    child = spawn(process.execPath, [entry], {
        // Forward our env (PATIENT_STELLAR_SECRET, PATIENT_ASP_BLINDING, STELLAR_*, …).
        env: { ...process.env, PROVER_SIDECAR_PORT: port },
        // CRITICAL: the MCP server speaks its protocol over *our* stdout. Never let the
        // child write there. Surface its stderr logs; ignore its stdout.
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.on('exit', (code, signal) => {
        log(`prover sidecar exited (code=${code} signal=${signal})`);
        child = null;
    });

    if (!cleanupRegistered) {
        cleanupRegistered = true;
        const kill = () => {
            if (child && !child.killed) child.kill('SIGTERM');
        };
        process.on('exit', kill);
        process.on('SIGINT', () => {
            kill();
            process.exit(0);
        });
        process.on('SIGTERM', () => {
            kill();
            process.exit(0);
        });
    }
}

async function waitForHealth(cfg: SidecarConfig): Promise<HealthBody> {
    const deadline = Date.now() + cfg.bootTimeoutMs;
    let logged = false;
    while (Date.now() < deadline) {
        // If we spawned it and it already died, fail fast with a useful hint.
        if (child === null && cleanupRegistered) {
            throw new Error(
                'prover sidecar process exited before reporting healthy. Common cause: ' +
                    'Chromium not installed — run `pnpm --filter mpp-demo-prover-sidecar ' +
                    'exec playwright install chromium`. Check the [sidecar] logs above.',
            );
        }
        const h = await health(cfg.sidecarUrl);
        if (h?.ok) return h;
        if (!logged) {
            log('waiting for prover to warm up (headless Chromium + WASM + chain sync)…');
            logged = true;
        }
        await sleep(1500);
    }
    throw new Error(
        `prover sidecar did not become healthy within ${cfg.bootTimeoutMs}ms at ${cfg.sidecarUrl}.`,
    );
}

function runBootstrap(cfg: SidecarConfig): Promise<void> {
    const entry = resolve(cfg.sidecarDir, 'setup.js');
    if (!existsSync(entry)) {
        throw new Error(
            `prover-sidecar bootstrap not found at ${entry} — build the sidecar first.`,
        );
    }
    log(
        'patient has no spendable notes — running one-time bootstrap (derive keys, register ASP, deposit)…',
    );
    return new Promise<void>((res, rej) => {
        const proc = spawn(process.execPath, [entry], {
            env: { ...process.env },
            stdio: ['ignore', 'ignore', 'inherit'],
        });
        proc.on('error', rej);
        proc.on('exit', (code) =>
            code === 0 ? res() : rej(new Error(`bootstrap exited with code ${code}`)),
        );
    });
}

async function waitForFunded(cfg: SidecarConfig): Promise<void> {
    const deadline = Date.now() + cfg.fundTimeoutMs;
    while (Date.now() < deadline) {
        const h = await health(cfg.sidecarUrl);
        if (h && BigInt(h.unspentStroops) > 0n) {
            log(`patient funded: ${h.unspentStroops} stroops across ${h.notes} note(s).`);
            return;
        }
        await sleep(2000);
    }
    throw new Error(
        `bootstrap completed but no spendable notes surfaced within ${cfg.fundTimeoutMs}ms ` +
            '(indexer may still be catching up, or the deposit failed — check the [setup] logs above).',
    );
}

async function doEnsure(cfg: SidecarConfig): Promise<void> {
    let h = await health(cfg.sidecarUrl);
    if (!h) {
        if (!cfg.autoStart) {
            throw new Error(
                `prover sidecar not reachable at ${cfg.sidecarUrl} and autostart is disabled ` +
                    '(PROVER_SIDECAR_AUTOSTART=0). Start it with ' +
                    '`pnpm --filter mpp-demo-prover-sidecar start`.',
            );
        }
        spawnSidecar(cfg);
        h = await waitForHealth(cfg);
    } else {
        log(`reusing already-running prover sidecar at ${cfg.sidecarUrl}.`);
    }

    if (BigInt(h.unspentStroops) === 0n) {
        await runBootstrap(cfg);
        await waitForFunded(cfg);
    }
}

let ready: Promise<void> | null = null;

/**
 * Idempotent: make sure a funded prover sidecar is up and reachable. Memoized
 * on success; a failure clears the memo so the next consult can retry.
 */
export function ensureSidecar(cfg: SidecarConfig = buildSidecarConfig(process.env)): Promise<void> {
    if (!ready) {
        ready = doEnsure(cfg).catch((err) => {
            ready = null;
            throw err;
        });
    }
    return ready;
}
