/**
 * Transport-level readers shared by the integration tests: the ephemeral port a
 * listening server bound, and the payload of a Streamable-HTTP SSE frame.
 */
import type { AddressInfo } from "node:net";

/** Both `node:http` and `node:net` servers expose exactly this much. */
type Addressable = {
  address: () => string | AddressInfo | null;
};

function isAddressInfo(
  address: string | AddressInfo | null,
): address is AddressInfo {
  return address !== null && typeof address !== "string";
}

/** The ephemeral port a server bound after `listen(0)`. */
export function portOf(server: Addressable): number {
  const address = server.address();

  if (!isAddressInfo(address)) {
    throw new Error(
      `server is not listening on a TCP port: ${String(address)}`,
    );
  }

  return address.port;
}

/**
 * The `data:` payload of an SSE response body. Returned as text so the caller
 * parses it with an annotated binding and states the frame's shape itself.
 */
export function sseData(raw: string): string {
  const line = raw
    .split("\n")
    .find((candidate) => candidate.startsWith("data:"));

  if (!line) throw new Error(`no SSE data frame in: ${raw}`);

  return line.slice("data:".length).trim();
}
