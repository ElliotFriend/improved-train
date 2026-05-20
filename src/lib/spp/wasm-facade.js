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
    const Original = window.Worker;
    if (Original.__sppPatched) return;
    function Patched(url, opts) {
        let resolved = url;
        if (typeof resolved === 'string' && resolved.startsWith('./js/')) {
            resolved = '/spp' + resolved.slice(1); // "./js/x.js" → "/spp/js/x.js"
        }
        return new Original(resolved, opts);
    }
    Patched.prototype = Original.prototype;
    Patched.__sppPatched = true;
    window.Worker = Patched;
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
