import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
    plugins: [tailwindcss(), sveltekit()],
    // snarkjs spawns a Web Worker at runtime (via the `web-worker` shim in Node).
    // If Vite bundles it into the SSR output, the bundle eagerly evaluates the
    // worker entry on the main thread during `vite build` and crashes with
    // `Cannot destructure property 'mod' of 'threads.workerData'`. Keep snarkjs
    // (and its transitive `web-worker`) external so they're required at runtime.
    ssr: { external: ['snarkjs', 'web-worker'] },
});
