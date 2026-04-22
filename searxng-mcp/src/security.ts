import { Resolver } from "node:dns";

// Each entry is [networkInt, prefixLength] in IPv4/CIDR form.
const PRIVATE_CIDRS: [number, number][] = [
  [ipv4ToInt(10, 0, 0, 0), 8],         // 10.0.0.0/8
  [ipv4ToInt(172, 16, 0, 0), 12],      // 172.16.0.0/12
  [ipv4ToInt(192, 168, 0, 0), 16],     // 192.168.0.0/16
  [ipv4ToInt(127, 0, 0, 0), 8],        // 127.0.0.0/8 (loopback)
  [ipv4ToInt(169, 254, 0, 0), 16],     // 169.254.0.0/16 (link-local)
  [ipv4ToInt(0, 0, 0, 0), 8],          // 0.0.0.0/8 (this-network)
];

function ipv4ToInt(a: number, b: number, c: number, d: number): number {
  // Use >>> 0 to keep the value as an unsigned 32-bit int.
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function parseIPv4(ip: string): number | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ipv4ToInt(parts[0], parts[1], parts[2], parts[3]);
}

function isPrivateIP(ip: string): boolean {
  const ipInt = parseIPv4(ip);
  if (ipInt === null) return false;
  return PRIVATE_CIDRS.some(([network, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (ipInt & mask) === (network & mask);
  });
}

export async function validateUrl(url: string): Promise<{ valid: true } | { valid: false; reason: string }> {
  try {
    const parsed = new URL(url);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { valid: false, reason: `Scheme not allowed: ${parsed.protocol}` };
    }

    const hostname = parsed.hostname;

    if (hostname === "localhost" || hostname === "0.0.0.0" || hostname === "[::1]") {
      return { valid: false, reason: "Localhost not allowed" };
    }

    // Resolve hostname to IP and check
    try {
      const resolver = new Resolver();
      const addresses = await new Promise<string[]>((resolve, reject) => {
        resolver.resolve4(hostname, (err, addrs) => {
          if (err) reject(err);
          else resolve(addrs || []);
        });
      });

      if (addresses.length === 0) {
        // DNS resolution failed — allow, will fail on HTTP request
        return { valid: true };
      }

      for (const addr of addresses) {
        if (isPrivateIP(addr)) {
          return { valid: false, reason: `DNS rebinding detected: ${hostname} resolves to private IP ${addr}` };
        }
      }
    } catch {
      // DNS resolution failed — allow, will fail on HTTP request
    }

    return { valid: true };
  } catch (e) {
    return { valid: false, reason: `Invalid URL: ${e instanceof Error ? e.message : String(e)}` };
  }
}
