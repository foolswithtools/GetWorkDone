// The addresses a webhook may never reach (GWP#6, docs/outputs.md). A webhook URL is user-configured, so
// without this a team admin could make the API call its own network: the task metadata endpoints
// (169.254.169.254, 169.254.170.2), the VPC's private ranges, the database, loopback. Every address a
// webhook's host resolves to is checked when it is sent to; one blocked address refuses the send.
import { BlockList, isIP } from 'node:net';

const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including the instance and task metadata endpoints
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and the broadcast address
] as const) BLOCKED.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 96], // unspecified, loopback and the deprecated IPv4-compatible addresses
  ['64:ff9b::', 96], // NAT64, likewise
  ['2002::', 16], // 6to4, likewise
  ['fc00::', 7], // unique local, including the IPv6 metadata endpoint fd00:ec2::254
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) BLOCKED.addSubnet(network, prefix, 'ipv6');
// IPv4-mapped addresses (::ffff:0:0/96) would reach any IPv4 address, blocked ones included, so all are
// refused. They get a list of their own: BlockList checks every IPv4 address against an IPv6 rule as
// its mapped form, so this rule in BLOCKED would refuse all of IPv4.
const MAPPED = new BlockList();
MAPPED.addSubnet('::ffff:0:0', 96, 'ipv6');

/** True when a webhook must not connect to `address`; anything that is not an IP address is blocked. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  return BLOCKED.check(address, 'ipv6') || MAPPED.check(address, 'ipv6');
}
