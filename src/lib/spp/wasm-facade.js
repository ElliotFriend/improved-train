// @ts-nocheck
// Loads the stellar-private-payments wasm-bindgen bundle from /spp/js/.
//
// The Rust web platform crate spawns workers with hardcoded URLs like
// "./js/storage-worker.js" (gloo-worker resolves those against the document's
// base URL). On our SvelteKit pages the document base is e.g. /a2a, so we
// monkey-patch the Worker constructor to redirect "./js/*" → "/spp/js/*".

let handle = null;

function patchWorkerUrls() {
    if (typeof window === 'undefined') return;
    if (window.Blob.__sppPatched) return;

    // gloo-worker spawns workers from a bootstrap Blob that contains
    // `import * as bindgen from './js/storage-worker.js'`-style source. Worker
    // base URL = the blob URL (origin only), so those relative paths resolve to
    // /js/... at the site root (404). Rewrite the bootstrap source so the
    // imports point at /spp/js/ instead.
    const OrigBlob = window.Blob;
    function PatchedBlob(parts, opts) {
        const rewritten = (parts || []).map((p) => {
            if (typeof p !== 'string') return p;
            // gloo-worker resolves the relative path to an absolute URL against
            // the document base BEFORE building the bootstrap blob, so the
            // string we see here is like
            //   `import init from 'http://host/js/storage-worker.js'; await init();`
            // Rewrite "/js/<worker>.js" → "/spp/js/<worker>.js" wherever it appears.
            return p.replace(
                /\/js\/(storage-worker|prover-worker)\.js/g,
                '/spp/js/$1.js',
            );
        });
        return new OrigBlob(rewritten, opts);
    }
    PatchedBlob.prototype = OrigBlob.prototype;
    PatchedBlob.__sppPatched = true;
    window.Blob = PatchedBlob;
}

export async function initializeWasm(rpcUrl) {
    if (handle) return handle;
    if (typeof window === 'undefined') {
        throw new Error('initializeWasm must be called in the browser');
    }
    patchWorkerUrls();
    // The Function() trick hides the dynamic import from Rollup's static
    // resolver so it doesn't try to bundle /spp/js/web.js (it's served from
    // static/ as a runtime asset and not part of our module graph).
    const dynamicImport = new Function('u', 'return import(u)');
    const spp = await dynamicImport('/spp/js/web.js');
    await spp.default('/spp/js/web_bg.wasm');
    const config = new spp.Config(rpcUrl);
    handle = await spp.mainThread(config);
    return handle;
}

export const getHandle = () => {
    if (!handle) throw new Error('WASM not initialized. Call initializeWasm first.');
    return handle;
};
