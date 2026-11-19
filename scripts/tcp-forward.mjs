#!/usr/bin/env node
/**
 * Tiny TCP forwarder for local smoke testing.
 *
 * WSL2 cannot reach a Windows service bound to 127.0.0.1, so when the
 * platform under test runs inside WSL and the LLM endpoint runs on the
 * Windows host, forward a host-reachable port to the loopback one:
 *
 *   node scripts/tcp-forward.mjs 3426 127.0.0.1:3425
 *
 * Then point the provider at http://<windows-host-ip>:3426 from WSL.
 * Not part of the platform; a test convenience only.
 */
import { createServer, connect } from 'node:net';

const [, , listenPort, target, bindHost = '0.0.0.0'] = process.argv;
if (!listenPort || !target) {
  console.error('usage: node scripts/tcp-forward.mjs <listenPort> <host:port> [bindHost]');
  process.exit(2);
}
const [targetHost, targetPort] = target.split(':');

const server = createServer((client) => {
  const upstream = connect(Number(targetPort), targetHost);
  client.pipe(upstream);
  upstream.pipe(client);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on('error', close);
  upstream.on('error', close);
});
server.listen(Number(listenPort), bindHost, () => {
  console.log(`forwarding ${bindHost}:${listenPort} -> ${target}`);
});
