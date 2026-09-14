import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { AppError } from './errors.js';

// Resolve once, reject every non-public address, then connect to the checked IP.
// The original hostname is retained for TLS SNI/certificate verification.
export async function mailEndpoint(host: string, allowed: Set<string>) {
  if (!allowed.has(host))
    throw new AppError('HOST_NOT_ALLOWED', 'Mail host is not enabled by the service operator.');
  const addresses = await lookup(host, { all: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => ipaddr.process(address).range() !== 'unicast')
  )
    throw new AppError(
      'PRIVATE_NETWORK',
      'Mail connections to private or reserved networks are blocked.',
    );
  return { address: addresses[0]!.address, servername: host };
}
