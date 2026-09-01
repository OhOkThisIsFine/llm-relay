import { createServer, type Server, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { createProxy, type ProxyDeps } from "../../src/server.js";
import type { Config } from "../../src/config-types.js";

export interface TestServerHandle {
  server: Server;
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
}

export class TestServerTracker {
  private readonly servers: Server[] = [];

  track<T extends Server>(server: T): T {
    this.servers.push(server);
    return server;
  }

  async closeAll(): Promise<void> {
    const active = this.servers.splice(0);
    await Promise.all(
      active.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
  }
}

export async function startHttpServer(
  serverOrListener: Server | RequestListener,
  tracker?: TestServerTracker,
): Promise<TestServerHandle> {
  const server = typeof serverOrListener === "function" ? createServer(serverOrListener) : serverOrListener;
  if (tracker) tracker.track(server);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    server,
    port,
    baseUrl,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export async function createTestRelayServer(
  config: Config,
  deps?: Partial<ProxyDeps>,
  tracker?: TestServerTracker,
): Promise<TestServerHandle> {
  const proxy = createProxy(config, deps);
  return startHttpServer(proxy, tracker);
}
