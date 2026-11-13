import test from 'node:test';
import assert from 'node:assert/strict';
import { clientKey } from '../lib/ip.js';

test('IPv4 : inchangée, et l’IPv4 mappée en IPv6 désigne le même client', () => {
  assert.equal(clientKey('203.0.113.7'), '203.0.113.7');
  assert.equal(clientKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(clientKey('::FFFF:127.0.0.1'), '127.0.0.1');
});

test('IPv6 : toutes les adresses d’un même /64 donnent la même clé', () => {
  const a = clientKey('2001:db8:1:2::1');
  assert.equal(a, '2001:db8:1:2::/64');
  assert.equal(clientKey('2001:db8:1:2:ffff:abcd:1234:9'), a);
  assert.equal(clientKey('2001:0db8:0001:0002:0000:0000:0000:0005'), a);
  assert.equal(clientKey('2001:DB8:1:2::'), a);
});

test('IPv6 : deux /64 différents donnent deux clés différentes', () => {
  assert.notEqual(clientKey('2001:db8:1:2::1'), clientKey('2001:db8:1:3::1'));
  assert.notEqual(clientKey('2001:db8:1:2::1'), clientKey('2001:db9:1:2::1'));
});

test('IPv6 : formes abrégées, boucle locale, zone et suffixe IPv4', () => {
  assert.equal(clientKey('::1'), '0:0:0:0::/64');
  assert.equal(clientKey('::'), '0:0:0:0::/64');
  assert.equal(clientKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(clientKey('64:ff9b::192.0.2.1'), '64:ff9b:0:0::/64');
});

test('valeurs absentes ou inattendues : ne lèvent pas d’exception', () => {
  assert.equal(clientKey(undefined), 'unknown');
  assert.equal(clientKey(''), 'unknown');
  assert.equal(typeof clientKey('n’importe quoi'), 'string');
});
