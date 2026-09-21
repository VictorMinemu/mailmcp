import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { AppError } from './errors.js';

// '*' opts into all public mail providers; an empty set remains deny-all.
// Both account writes and outgoing connections must use the same host policy.
export function assertMailHostAllowed(host: string, allowed: Set<string>) {
  if (!allowed.has('*') && !allowed.has(host))
    throw new AppError('HOST_NOT_ALLOWED', 'Mail host is not enabled by the service operator.');
}

type MailResolver = (host: string) => Promise<readonly { address: string }[]>;
const resolveMailHost: MailResolver = (host) => lookup(host, { all: true });

// Resolve once, reject every non-public address, then connect to the checked IP.
// Even '*' cannot bypass this check. Retain the hostname for TLS verification.
export async function mailEndpoint(
  host: string,
  allowed: Set<string>,
  resolveHost: MailResolver = resolveMailHost,
) {
  assertMailHostAllowed(host, allowed);
  const addresses = await resolveHost(host);
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
