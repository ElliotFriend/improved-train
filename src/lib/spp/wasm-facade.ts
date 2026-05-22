// Loads the stellar-private-payments wasm-bindgen bundle from /spp/js/.
//
// The Rust web platform crate spawns workers with hardcoded URLs like
// "./js/storage-worker.js" (gloo-worker resolves those against the document's
// base URL). On our SvelteKit pages the document base is e.g. /, so we
// monkey-patch the Worker constructor's bootstrap-Blob source to redirect
// "/js/<worker>.js" → "/spp/js/<worker>.js".

import type { WasmHandle } from './types.js';

type BlobCtor = typeof Blob & { __sppPatched?: true };

let handle: WasmHandle | null = null;

function patchWorkerUrls(): void {
    if (typeof window === 'undefined') return;
    const w = window as Window & { Blob: BlobCtor };
    if (w.Blob.__sppPatched) return;

    const OrigBlob = w.Blob;
    const PatchedBlob = function (this: Blob, parts?: BlobPart[], opts?: BlobPropertyBag) {
        const rewritten = (parts ?? []).map((p) => {
            if (typeof p !== 'string') return p;
            return p.replace(/\/js\/(storage-worker|prover-worker)\.js/g, '/spp/js/$1.js');
        });
        return new OrigBlob(rewritten, opts);
    } as unknown as BlobCtor;
    PatchedBlob.prototype = OrigBlob.prototype;
    PatchedBlob.__sppPatched = true;
    w.Blob = PatchedBlob;
}

interface SppModule {
    default: (wasmUrl: string) => Promise<unknown>;
    Config: new (rpcUrl: string) => unknown;
    mainThread: (config: unknown) => Promise<WasmHandle>;
}

export async function initializeWasm(rpcUrl: string): Promise<WasmHandle> {
    if (handle) return handle;
    if (typeof window === 'undefined') {
        throw new Error('initializeWasm must be called in the browser');
    }
    patchWorkerUrls();
    // The Function() trick hides the dynamic import from Rollup's static
    // resolver so it doesn't try to bundle /spp/js/web.js (it's served from
    // static/ as a runtime asset and not part of our module graph).
    const dynamicImport = new Function('u', 'return import(u)') as (
        u: string,
    ) => Promise<SppModule>;
    const spp = await dynamicImport('/spp/js/web.js');
    await spp.default('/spp/js/web_bg.wasm');
    const config = new spp.Config(rpcUrl);
    handle = await spp.mainThread(config);
    return handle;
}

export function getHandle(): WasmHandle {
    if (!handle) throw new Error('WASM not initialized. Call initializeWasm first.');
    return handle;
}
