'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { TextEncoder } = require('node:util');
const { Buffer } = require('node:buffer');
const { describe, it } = require('node:test');

const SRC = path.join(__dirname, '..', 'public', 'app', 'backup-v2-core.js');

function loadCore() {
  const code = fs.readFileSync(SRC, 'utf8');
  const sandbox = { crypto: webcrypto, TextEncoder, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'backup-v2-core.js' });
  return sandbox.OLBackupV2Core;
}

const core = loadCore();

async function digestOf(u8) {
  const buf = await webcrypto.subtle.digest('SHA-256', u8);
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  const a = new Uint8Array(buf);
  let i = 0;
  while (i < a.length) {
    const rem = a.length - i;
    const x = a[i++], y = rem > 1 ? a[i++] : 0, z = rem > 2 ? a[i++] : 0;
    const n = ((x << 16) | (y << 8) | z) >>> 0;
    out += B64[(n >>> 18) & 63] + B64[(n >>> 12) & 63];
    out += rem > 1 ? B64[(n >>> 6) & 63] : '=';
    out += rem > 2 ? B64[n & 63] : '=';
  }
  return out.replace(/=+$/, '');
}

describe('backup-v2-core / envelope bytes', () => {
  it('serializes once into UTF-8 JSON bytes', () => {
    const payload = { app: 'earthonline', version: 4, data: { a: '中文' } };
    const u8 = core.encodeEnvelopeToBytes(payload);
    assert.deepEqual(Buffer.from(u8), Buffer.from(JSON.stringify(payload), 'utf8'));
  });

  it('rejects circular payload', () => {
    const bad = {}; bad.self = bad;
    assert.throws(() => core.encodeEnvelopeToBytes(bad), /payload-serialize-failed/);
  });
});

describe('backup-v2-core / sealed bytes', () => {
  it('does not expose a mutable byte reference', async () => {
    const u8 = core.encodeEnvelopeToBytes({ a: 1 });
    const sealed = await core.sealPayloadBytes(u8);
    assert.equal(sealed.bytes, undefined);
    const first = sealed.copyOut();
    first[0] = 0;
    const second = sealed.copyOut();
    assert.notEqual(second[0], 0);
    assert.equal(second.length, u8.length);
  });

  it('computes sha256 over the private copy', async () => {
    const u8 = core.encodeEnvelopeToBytes({ a: 2 });
    const sealed = await core.sealPayloadBytes(u8);
    assert.equal(sealed.hash, 'sha256-' + await digestOf(u8));
  });

  it('copies Buffer input instead of aliasing Buffer.slice memory', async () => {
    const buf = Buffer.from([1, 2, 3]);
    const sealed = await core.sealPayloadBytes(buf);
    buf[0] = 9;
    assert.deepEqual([...sealed.copyOut()], [1, 2, 3]);
    assert.equal(sealed.hash, 'sha256-' + await digestOf(new Uint8Array([1, 2, 3])));
  });
});

describe('backup-v2-core / immutable identity', () => {
  it('uses one identity value for attemptId and writeId', async () => {
    const im = await core.makeAttemptIdentity({
      writeId: 'w-1', clientId: 'c-1', clientRevision: 5, baseRev: 10,
      payloadHash: 'sha256-abc', payloadBytes: 3,
      identity: { conflictEpoch: 2, blockEpoch: 1, expectedConflictState: { mode: 'none' } }
    });
    assert.equal(im.attemptId, im.writeId);
    assert.equal(im.writeId, 'w-1');
    assert.equal(im.objectKey, 'earthonline/backups/w-1.json');
    assert.equal(await core.verifyImmutableHash(im), true);
  });

  it('deep freezes nested identity', async () => {
    const im = await core.makeAttemptIdentity({
      writeId: 'w-2', clientId: 'c-1', clientRevision: 1, baseRev: 0,
      payloadHash: 'sha256-abc', payloadBytes: 3,
      identity: { conflictEpoch: 0, blockEpoch: 0, expectedConflictState: { mode: 'none' } }
    });
    assert.throws(() => { im.identity.blockEpoch = 99; }, TypeError);
    assert.throws(() => { im.identity.expectedConflictState.mode = 'present'; }, TypeError);
  });

  it('detects a changed immutable hash', async () => {
    const im = await core.makeAttemptIdentity({
      writeId: 'w-3', clientId: 'c-1', clientRevision: 1, baseRev: 0,
      payloadHash: 'sha256-abc', payloadBytes: 3,
      identity: { conflictEpoch: 0, blockEpoch: 0, expectedConflictState: { mode: 'none' } }
    });
    const tampered = { ...im, identity: { ...im.identity, blockEpoch: 7 } };
    assert.equal(await core.verifyImmutableHash(tampered), false);
  });

  it('detects extra and missing immutable fields', async () => {
    const im = await core.makeAttemptIdentity({
      writeId: 'w-3b', clientId: 'c-1', clientRevision: 1, baseRev: 0,
      payloadHash: 'sha256-abc', payloadBytes: 3,
      identity: { conflictEpoch: 0, blockEpoch: 0, expectedConflictState: { mode: 'none' } }
    });
    const extra = { ...im, evil: 1 };
    const missing = { ...im };
    delete missing.baseRev;
    assert.equal(await core.verifyImmutableHash(extra), false);
    assert.equal(await core.verifyImmutableHash(missing), false);
  });

  it('does not equate swapped numeric fields', async () => {
    const im = await core.makeAttemptIdentity({
      writeId: 'w-3c', clientId: 'c-1', clientRevision: 7, baseRev: 2,
      payloadHash: 'sha256-abc', payloadBytes: 3,
      identity: { conflictEpoch: 0, blockEpoch: 0, expectedConflictState: { mode: 'none' } }
    });
    const swapped = { ...im, clientRevision: im.baseRev, baseRev: im.clientRevision };
    assert.equal(await core.verifyImmutableHash(swapped), false);
  });

  it('generates distinct identities for distinct attempts', async () => {
    function make() {
      return core.makeAttemptIdentity({
        clientId: 'c-1', clientRevision: 1, baseRev: 0,
        payloadHash: 'sha256-abc', payloadBytes: 3,
        identity: { conflictEpoch: 0, blockEpoch: 0, expectedConflictState: { mode: 'none' } }
      });
    }
    const a = await make();
    const b = await make();
    assert.notEqual(a.writeId, b.writeId);
    assert.equal(a.attemptId, a.writeId);
    assert.equal(b.attemptId, b.writeId);
  });

  it('rejects unsafe write ids', () => {
    assert.throws(() => core.objectKeyOf('../escape'), /write-id-invalid/);
  });
});

describe('backup-v2-core / payload row checks', () => {
  async function makeIm() {
    return core.makeAttemptIdentity({
      writeId: 'w-4', clientId: 'c-1', clientRevision: 1, baseRev: 0,
      payloadHash: 'sha256-abc', payloadBytes: 3,
      identity: { conflictEpoch: 0, blockEpoch: 0, expectedConflictState: { mode: 'none' } }
    });
  }
  it('accepts a matching row', async () => {
    const im = await makeIm();
    assert.equal(core.assertPayloadRow({
      hash: im.payloadHash, bytes: im.payloadBytes, objectKey: im.objectKey,
      body: new Uint8Array(3)
    }, im), null);
  });
  it('rejects missing / hash / size / key mismatches', async () => {
    const im = await makeIm();
    const good = { hash: im.payloadHash, bytes: im.payloadBytes,
                   objectKey: im.objectKey, body: new Uint8Array(3) };
    assert.equal(core.assertPayloadRow(null, im), 'payload-unavailable');
    assert.equal(core.assertPayloadRow({ ...good, hash: 'x' }, im), 'payload-hash-mismatch');
    assert.equal(core.assertPayloadRow({ ...good, body: new Uint8Array(2) }, im), 'payload-size-mismatch');
    assert.equal(core.assertPayloadRow({ ...good, objectKey: 'other' }, im), 'payload-object-key-mismatch');
    assert.equal(core.assertPayloadRow({ ...good, body: new DataView(new ArrayBuffer(3)) }, im), null);
  });
});

describe('backup-v2-core / canonical state', () => {
  it('ignores stateEpoch and sorts attempts', () => {
    const a = { clientId: 'c', attempts: [
      { immutable: { attemptId: 'b' } }, { immutable: { attemptId: 'a' } }
    ], stateEpoch: 1 };
    const b = { clientId: 'c', attempts: [
      { immutable: { attemptId: 'a' } }, { immutable: { attemptId: 'b' } }
    ], stateEpoch: 9 };
    assert.equal(core.canonicalState(a), core.canonicalState(b));
  });
  it('fails closed on invalid values and extra keys', () => {
    assert.throws(() => core.canonicalState({ seq: NaN }), /state-schema-invalid/);
    assert.throws(() => core.canonicalState({ unknownKey: 1 }), /state-schema-invalid/);
    const cyc = {}; cyc.self = cyc;
    assert.throws(() => core.canonicalState({ attempts: cyc }), /state-schema-invalid/);
  });
  it('treats an absent key as null, not as invalid', () => {
    assert.doesNotThrow(() => core.canonicalState({ clientId: 'c' }));
  });

  it('rejects runtime fields instead of silently dropping them', () => {
    assert.throws(() => core.canonicalState({ clientId: 'c', runtimeOnly: 1 }), /state-schema-invalid/);
    assert.throws(() => core.stripRuntime({ clientId: 'c', runtimeOnly: 1 }), /state-schema-invalid/);
  });

  it('keeps the exported persisted-key list immutable', () => {
    assert.ok(Object.isFrozen(core.PERSIST_KEYS));
    assert.throws(() => { core.PERSIST_KEYS.push('evil'); }, /not extensible|frozen|Cannot add/);
  });
});
