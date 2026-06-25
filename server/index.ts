import 'dotenv/config';
import './logging.js';
import { createServer, type Server } from 'node:http';
import app from './app.js';
import { adapter } from './agent.js';
import { shutdownLiveRuns } from './live-runs.js';
import { shutdownResponseStore } from './response-store.js';
import { ensureGatewayStateDirs } from './paths.js';

ensureGatewayStateDirs();

const PORT = parseInt(process.env.PORT || '3737', 10);
const HOST = process.env.HOST || '0.0.0.0';
// An explicit PORT must bind exactly: behind the platform edge the route points
// at one port, so silently falling back would strand the instance URL.
const PORT_FALLBACK_ATTEMPTS = process.env.PORT ? 1 : 20;

const httpServer = createServer(app);
let shuttingDown = false;

type ShutdownReason = NodeJS.Signals | 'startup-error';

async function listenWithFallback(server: Server, startPort: number, maxAttempts: number): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const tryPort = startPort + i;
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.off('listening', onListening);
          rejectListen(err);
        };
        const onListening = () => {
          server.off('error', onError);
          resolveListen();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(tryPort, HOST);
      });
      if (tryPort !== startPort) {
        console.warn(`Port ${startPort} was busy — using port ${tryPort} instead.`);
      }
      return tryPort;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error(`Could not find a free port after ${maxAttempts} attempts starting from ${startPort}.`);
}

async function main() {
  try {
    await adapter.start?.();
  } catch (error) {
    console.error(
      'Hermes backend failed to start — the gateway will serve but Hermes-routed turns fail until the worker recovers (other configured harnesses are unaffected):',
      error instanceof Error ? error.message : error,
    );
  }

  const boundPort = await listenWithFallback(httpServer, PORT, PORT_FALLBACK_ATTEMPTS);
  console.log(`Agent37 Gateway listening on http://${HOST}:${boundPort}`);
}

function closeHttpServer(): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    if (!httpServer.listening) {
      resolveClose();
      return;
    }
    httpServer.close((error?: Error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
    httpServer.closeAllConnections();
  });
}

async function shutdown(reason: ShutdownReason, exitCode = 0): Promise<void> {
  if (shuttingDown) {
    httpServer.closeAllConnections();
    process.exit(1);
  }
  shuttingDown = true;

  const forceExit = setTimeout(() => {
    console.error(`Forced shutdown after ${reason}`);
    process.exit(1);
  }, 5000);
  forceExit.unref();

  shutdownLiveRuns();
  shutdownResponseStore();
  const results = await Promise.allSettled([closeHttpServer(), adapter.stop?.() ?? Promise.resolve()]);
  for (const result of results) {
    if (result.status === 'rejected') console.error(result.reason);
  }

  clearTimeout(forceExit);
  process.exit(results.some((result) => result.status === 'rejected') ? 1 : exitCode);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((error) => {
  console.error(error);
  void shutdown('startup-error', 1);
});
