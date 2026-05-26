/**
 * Viability smoke test: does the browser-only stellar-private-payments WASM
 * initialize under headless Chromium?
 *
 * Boots the static server, launches Playwright headless Chromium, loads the
 * prover page, and calls __sppInit + __sppContractConfig. Prints PASS/FAIL.
 *
 *   pnpm --filter mpp-demo-prover-sidecar smoke
 *   RPC_URL=https://soroban-testnet.stellar.org pnpm ... smoke
 */
import { chromium } from 'playwright';
import { startStaticServer } from './server.js';

const RPC_URL = process.env.RPC_URL ?? 'https://soroban-testnet.stellar.org';

async function main() {
    const { server, port } = await startStaticServer();
    const origin = `http://127.0.0.1:${port}`;
    console.error(`[smoke] static server on ${origin}`);

    const browser = await chromium.launch({
        headless: true,
        args: ['--headless=new'],
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on('console', (msg) => console.error(`[page:${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => console.error(`[page:error] ${err.message}`));

    let pass = false;
    try {
        await page.goto(`${origin}/`, { waitUntil: 'load', timeout: 30_000 });
        await page.waitForFunction(() => (window as unknown as { __sppReady?: boolean }).__sppReady, {
            timeout: 10_000,
        });

        console.error('[smoke] page loaded, calling __sppInit…');
        const initResult = await page.evaluate(async (rpcUrl) => {
            const w = window as unknown as { __sppInit: (u: string) => Promise<unknown> };
            return w.__sppInit(rpcUrl);
        }, RPC_URL);
        console.error(`[smoke] init result: ${JSON.stringify(initResult)}`);

        console.error('[smoke] calling __sppContractConfig…');
        const cfg = await page.evaluate(async () => {
            const w = window as unknown as { __sppContractConfig: () => Promise<unknown> };
            return w.__sppContractConfig();
        });
        console.error(`[smoke] contractConfig: ${JSON.stringify(cfg)}`);
        pass = !!cfg;
    } catch (err) {
        console.error(`[smoke] FAILED: ${err instanceof Error ? err.message : err}`);
    } finally {
        await browser.close();
        server.close();
    }

    if (pass) {
        console.error('[smoke] PASS — WASM initializes under headless Chromium');
        process.exit(0);
    } else {
        console.error('[smoke] FAIL — WASM did not initialize headless');
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('[smoke] fatal:', err);
    process.exit(1);
});
