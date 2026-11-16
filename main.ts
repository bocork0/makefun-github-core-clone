// main.ts — the forge entrypoint: one process, one store, one HTTP server.
//
// When MAKEFUN_ENV_URL is set (the trial), the process binds an ephemeral
// port, registers it with the suite, serves until the suite reports done,
// then exits 0. Otherwise it listens on PORT (default 3000) for local use.

import { Store } from './store.ts';
import { createServer, configuredToken } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL;
const PORT = Number(process.env.PORT ?? 3000) || 3000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const store = new Store();
  const token = configuredToken();
  const server = createServer(store, token);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(ENV_URL ? 0 : PORT, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : PORT;
  console.log(`forge listening on port ${port}`);

  if (!ENV_URL) return; // Local mode: serve until killed.

  // Trial mode: register, then poll /done until the suite finishes.
  const registerUrl = `${ENV_URL.replace(/\/$/, '')}/register`;
  const doneUrl = `${ENV_URL.replace(/\/$/, '')}/done`;
  const registerResponse = await fetch(registerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (!registerResponse.ok) {
    console.error(`register failed: HTTP ${registerResponse.status}`);
    process.exit(1);
  }
  for (;;) {
    await sleep(250);
    try {
      const response = await fetch(doneUrl);
      if (response.ok) {
        const data = (await response.json()) as { done?: unknown };
        if (data.done === true) break;
      }
    } catch {
      // The suite endpoint is briefly unreachable during boot; keep polling.
    }
  }
  server.close();
  process.exit(0);
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
