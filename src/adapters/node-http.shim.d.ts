/**
 * The sliver of `node:http` that `undici.integration.test.ts` uses.
 *
 * Declared here rather than by installing `@types/node`, because ADR-014 keeps Node types out of
 * this project on purpose: with them present a runtime-agnostic library type-checks as if it were
 * Node-only, and code drifts toward Node-shaped assumptions that break on Workers while still
 * compiling. The biome `noRestrictedGlobals` rule is the primary enforcement; the absence of
 * `@types/node` is the second layer, and installing it to satisfy one test file would remove it.
 *
 * Only the integration test needs a real HTTP server, and only these members of it.
 */
declare module "node:http" {
  export interface IncomingMessage {
    url?: string;
    method?: string;
    headers: Record<string, string | string[] | undefined>;
  }
  export interface ServerResponse {
    writeHead(status: number, headers?: Record<string, string>): void;
    end(body?: string): void;
  }
  export interface Server {
    listen(port: number, host: string, callback: () => void): void;
    close(callback: (err?: Error) => void): void;
    address(): { port: number } | string | null;
  }
  export function createServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Server;
}
