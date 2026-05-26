/**
 * Tiny static HTTP server that hosts the prover page + the vendored
 * stellar-private-payments WASM bundle, same-origin, so a Playwright-driven
 * headless Chromium can load and run it.
 *
 * Serves:
 *   GET /                  → public/prover.html
 *   GET /spp/<path>        → <repo>/static/spp/<path>
 *   GET /circuits/<path>   → <repo>/static/spp/circuits/<path>
 *     (the prover worker fetches circuit artifacts from `{origin}/circuits/…`;
 *      mirroring them here keeps everything same-origin)
 *
 * COOP/COEP are set so the WASM workers can use SharedArrayBuffer if the
 * sqlite/threading paths need cross-origin isolation. All assets are
 * same-origin, which satisfies COEP: require-corp.
 */
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// src/ and build/ both sit one level under prover-sidecar/, so ../../static
// resolves to <repo>/static from either.
const DEFAULT_STATIC = resolve(here, '../../static/spp');
const SPP_STATIC_DIR = process.env.SPP_STATIC_DIR
    ? resolve(process.env.SPP_STATIC_DIR)
    : DEFAULT_STATIC;
const PUBLIC_DIR = resolve(here, '../public');

const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.wasm': 'application/wasm',
    '.r1cs': 'application/octet-stream',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.tar.gz': 'application/gzip',
};

function mimeFor(path: string): string {
    const lower = path.toLowerCase();
    for (const ext of Object.keys(MIME)) {
        if (lower.endsWith(ext)) return MIME[ext];
    }
    return 'application/octet-stream';
}

/**
 * Resolve a request path under a root dir, refusing path traversal.
 * Returns null if the resolved path escapes the root.
 */
function safeJoin(root: string, requestPath: string): string | null {
    const clean = normalize(requestPath).replace(/^(\.\.[/\\])+/, '');
    const full = join(root, clean);
    if (full !== root && !full.startsWith(root + '/') && full !== root) return null;
    if (!full.startsWith(root)) return null;
    return full;
}

const ISOLATION_HEADERS: Record<string, string> = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
};

export function createStaticServer(): Server {
    return createServer(async (req, res) => {
        try {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const pathname = decodeURIComponent(url.pathname);

            let filePath: string | null = null;
            if (pathname === '/' || pathname === '/index.html') {
                filePath = join(PUBLIC_DIR, 'prover.html');
            } else if (pathname.startsWith('/spp/')) {
                filePath = safeJoin(SPP_STATIC_DIR, pathname.slice('/spp/'.length));
            } else if (pathname.startsWith('/circuits/')) {
                filePath = safeJoin(
                    join(SPP_STATIC_DIR, 'circuits'),
                    pathname.slice('/circuits/'.length),
                );
            }

            if (!filePath) {
                res.writeHead(404).end('not found');
                return;
            }

            const body = await readFile(filePath);
            res.writeHead(200, {
                'Content-Type': mimeFor(filePath),
                'Content-Length': body.length,
                ...ISOLATION_HEADERS,
            });
            res.end(body);
        } catch (err) {
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code === 'ENOENT') {
                res.writeHead(404).end('not found');
                return;
            }
            res.writeHead(500).end(`server error: ${err instanceof Error ? err.message : err}`);
        }
    });
}

export function startStaticServer(port = 0): Promise<{ server: Server; port: number }> {
    const server = createStaticServer();
    return new Promise((resolvePromise, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            const addr = server.address();
            if (addr && typeof addr === 'object') {
                resolvePromise({ server, port: addr.port });
            } else {
                reject(new Error('failed to get server port'));
            }
        });
    });
}
