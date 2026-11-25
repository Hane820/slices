/* backup-v2-core.js — 云端备份 v2 纯核心原语
 *
 * 本文件只实现冻结设计中与外部环境无关的部分：
 *   - envelope -> UTF-8 JSON 字节（唯一一次序列化）
 *   - 字节封装：私有副本 + copyOut，绝不暴露可修改的 TypedArray 引用
 *   - Attempt immutable 身份：attemptId === writeId（只生成一次）、深冻结、摘要校验
 *   - payload 行与 Attempt immutable 的一致性校验
 *   - 状态规范化比较（写临界区的 changed 判定）
 *
 * 不依赖：IndexedDB、localStorage、Web Locks、fetch、R2、Worker。
 * 浏览器以经典脚本加载，挂到 window.OLBackupV2Core。
 */
(function (global) {
  'use strict';

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  var PERSIST_KEYS = [
    'clientId', 'protocolVersion', 'pending', 'seq', 'dirtyAt',
    'serverRev', 'conflict', 'conflictEpoch', 'blockReason', 'blockEpoch',
    'autoUploadPaused', 'attempts', 'serverObservation', 'lastSuccessAt',
    'lastError', 'lastFailureAt', 'stateEpoch'
  ];

  function b64url(u8) {
    var out = '';
    var i = 0;
    while (i < u8.length) {
      var rem = u8.length - i;
      var a = u8[i++];
      var b = rem > 1 ? u8[i++] : 0;
      var c = rem > 2 ? u8[i++] : 0;
      var n = ((a << 16) | (b << 8) | c) >>> 0;
      out += B64[(n >>> 18) & 63] + B64[(n >>> 12) & 63];
      out += rem > 1 ? B64[(n >>> 6) & 63] : '=';
      out += rem > 2 ? B64[n & 63] : '=';
    }
    return out.replace(/=+$/, '');
  }

  function digest(u8) {
    if (!global.crypto || !global.crypto.subtle) {
      return Promise.reject(new Error('subtle-unavailable'));
    }
    return global.crypto.subtle.digest('SHA-256', u8).then(function (buf) {
      return b64url(new Uint8Array(buf));
    });
  }

  function encodeEnvelopeToBytes(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('payload-serialize-failed');
    }
    var text;
    try { text = JSON.stringify(payload); }
    catch (e) { throw new Error('payload-serialize-failed'); }
    if (typeof text !== 'string') throw new Error('payload-serialize-failed');
    return new TextEncoder().encode(text);
  }

  function copyBytes(u8) {
    if (!u8 || !ArrayBuffer.isView(u8)) throw new Error('bytes-type-invalid');
    var isDataView = typeof u8.getUint8 === 'function';
    if (!isDataView && u8.BYTES_PER_ELEMENT !== 1) throw new Error('bytes-type-invalid');
    var len = u8.byteLength;
    var out = new Uint8Array(len);
    for (var i = 0; i < len; i++) out[i] = isDataView ? u8.getUint8(i) : u8[i];
    return out;
  }

  async function sealPayloadBytes(u8) {
    var inner = copyBytes(u8);                      // 总是逐字节复制，避免 Buffer.slice 共享内存
    var sum = await digest(inner);
    var hash = 'sha256-' + sum;
    var len = inner.length;
    return Object.freeze({
      byteLength: len,
      hash: hash,
      copyOut: function () { return inner.slice(); } // 每次返回新副本
    });
  }

  function objectKeyOf(writeId) {
    if (typeof writeId !== 'string' || !writeId || !/^[A-Za-z0-9._-]+$/.test(writeId)) {
      throw new Error('write-id-invalid');
    }
    return 'earthonline/backups/' + writeId + '.json';
  }

  function assertNoExtraKeys(o, keys, label) {
    for (var k of Object.keys(o)) if (keys.indexOf(k) < 0) throw new Error(label + '-extra-key');
    for (var key of keys) if (!Object.prototype.hasOwnProperty.call(o, key)) throw new Error(label + '-missing-key');
  }

  var IMMUTABLE_KEYS = [
    'protocolVersion', 'attemptId', 'writeId', 'clientId', 'clientRevision',
    'baseRev', 'objectKey', 'payloadHash', 'payloadBytes', 'createdAt',
    'identity', 'immutableHash'
  ];
  var IDENTITY_KEYS = ['conflictEpoch', 'blockEpoch', 'expectedConflictState'];
  var EXPECTED_CONFLICT_KEYS = ['mode', 'id'];

  function assertImmutableCore(im, requireHash) {
    if (!im || typeof im !== 'object' || Array.isArray(im)) throw new Error('immutable-shape-invalid');
    assertNoExtraKeys(im, IMMUTABLE_KEYS, 'immutable');
    if (im.protocolVersion !== 2) throw new Error('immutable-protocol-invalid');
    if (typeof im.writeId !== 'string' || !im.writeId) throw new Error('immutable-write-id-invalid');
    if (im.attemptId !== im.writeId) throw new Error('attempt-id-mismatch');
    if (typeof im.clientId !== 'string' || !im.clientId) throw new Error('immutable-client-id-invalid');
    if (!Number.isInteger(im.clientRevision) || im.clientRevision < 0) throw new Error('immutable-client-revision-invalid');
    if (!Number.isInteger(im.baseRev) || im.baseRev < 0) throw new Error('immutable-base-rev-invalid');
    if (im.objectKey !== objectKeyOf(im.writeId)) throw new Error('immutable-object-key-invalid');
    if (typeof im.payloadHash !== 'string' || im.payloadHash.indexOf('sha256-') !== 0) throw new Error('immutable-payload-hash-invalid');
    if (!Number.isInteger(im.payloadBytes) || im.payloadBytes < 0) throw new Error('immutable-payload-bytes-invalid');
    if (!Number.isInteger(im.createdAt)) throw new Error('immutable-created-at-invalid');

    var id = im.identity;
    if (!id || typeof id !== 'object' || Array.isArray(id)) throw new Error('immutable-identity-invalid');
    assertNoExtraKeys(id, IDENTITY_KEYS, 'identity');
    if (!Number.isInteger(id.conflictEpoch) || id.conflictEpoch < 0) throw new Error('immutable-identity-invalid');
    if (!Number.isInteger(id.blockEpoch) || id.blockEpoch < 0) throw new Error('immutable-identity-invalid');
    var e = id.expectedConflictState;
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error('expected-conflict-state-invalid');
    assertNoExtraKeys(e, EXPECTED_CONFLICT_KEYS, 'expected-conflict-state');
    if (e.mode !== 'none' && e.mode !== 'present') throw new Error('expected-conflict-state-invalid');
    if (e.mode === 'present') {
      if (typeof e.id !== 'string' || !e.id) throw new Error('expected-conflict-id-invalid');
    } else if (e.id !== null) {
      throw new Error('expected-conflict-id-invalid');
    }

    if (requireHash && (typeof im.immutableHash !== 'string' || im.immutableHash.indexOf('sha256-') !== 0)) {
      throw new Error('immutable-hash-invalid');
    }
    return true;
  }

  /* 字段名固定、键序固定、额外/缺失字段 fail closed；hash 不覆盖 immutableHash 本身。 */
  function canonicalImmutable(im) {
    assertImmutableCore(im, false);
    var e = im.identity.expectedConflictState;
    return JSON.stringify({
      protocolVersion: im.protocolVersion,
      attemptId: im.attemptId,
      writeId: im.writeId,
      clientId: im.clientId,
      clientRevision: im.clientRevision,
      baseRev: im.baseRev,
      objectKey: im.objectKey,
      payloadHash: im.payloadHash,
      payloadBytes: im.payloadBytes,
      createdAt: im.createdAt,
      identity: {
        conflictEpoch: im.identity.conflictEpoch,
        blockEpoch: im.identity.blockEpoch,
        expectedConflictState: { mode: e.mode, id: e.mode === 'present' ? e.id : null }
      }
    });
  }

  function makeImmutableHash(im) {
    return digest(new TextEncoder().encode(canonicalImmutable(im))).then(function (sum) {
      return 'sha256-' + sum;
    });
  }

  function verifyImmutableHash(im) {
    if (!im || typeof im.immutableHash !== 'string') return Promise.resolve(false);
    try {
      return makeImmutableHash(im).then(function (h) { return h === im.immutableHash; },
                                        function () { return false; });
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (var k of Object.keys(o)) deepFreeze(o[k]);
    }
    return o;
  }

  function assertImmutableShapeSync(im) {
    assertImmutableCore(im, true);
    if (!Object.isFrozen(im) || !Object.isFrozen(im.identity) ||
        !Object.isFrozen(im.identity.expectedConflictState)) throw new Error('immutable-not-deep-frozen');
    return true;
  }

  function newWriteId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    throw new Error('random-uuid-unavailable');
  }

  async function makeAttemptIdentity(input) {
    if (!input || typeof input !== 'object') throw new Error('attempt-input-invalid');
    var writeId = input.writeId || newWriteId();
    var id = input.identity || {};
    var ecs = id.expectedConflictState || { mode: 'none' };
    if (ecs.mode !== 'none' && ecs.mode !== 'present') throw new Error('expected-conflict-state-invalid');
    if (ecs.mode === 'present' && typeof ecs.id !== 'string') throw new Error('expected-conflict-id-invalid');

    var im = {
      protocolVersion: 2,
      attemptId: writeId,                 // 与 writeId 同一个值，只生成一次
      writeId: writeId,
      clientId: input.clientId,
      clientRevision: input.clientRevision,
      baseRev: typeof input.baseRev === 'number' ? input.baseRev : 0,
      objectKey: objectKeyOf(writeId),
      payloadHash: input.payloadHash,
      payloadBytes: input.payloadBytes,
      createdAt: typeof input.createdAt === 'number' ? input.createdAt : Date.now(),
      identity: {
        conflictEpoch: id.conflictEpoch,
        blockEpoch: id.blockEpoch,
        expectedConflictState: { mode: ecs.mode, id: ecs.mode === 'present' ? ecs.id : null }
      },
      immutableHash: null
    };
    if (!Number.isInteger(im.clientRevision) || !Number.isInteger(im.identity.conflictEpoch) ||
        !Number.isInteger(im.identity.blockEpoch)) throw new Error('attempt-input-invalid');
    im.immutableHash = await makeImmutableHash(im);
    deepFreeze(im);
    assertImmutableShapeSync(im);
    return im;
  }

  function assertPayloadRow(row, im) {
    assertImmutableCore(im, true);
    if (!row || typeof row !== 'object') return 'payload-unavailable';
    if (row.hash !== im.payloadHash) return 'payload-hash-mismatch';
    if (row.bytes !== im.payloadBytes) return 'payload-size-mismatch';
    if (row.objectKey !== im.objectKey) return 'payload-object-key-mismatch';
    if (!ArrayBuffer.isView(row.body)) return 'payload-body-invalid';
    if (typeof row.body.getUint8 !== 'function' && row.body.BYTES_PER_ELEMENT !== 1) return 'payload-body-invalid';
    if (row.body.byteLength !== im.payloadBytes) return 'payload-size-mismatch';
    return null;
  }

  function stable(v, seen) {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error('state-schema-invalid');
      return v;
    }
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') {
      throw new Error('state-schema-invalid');
    }
    if (typeof v !== 'object') throw new Error('state-schema-invalid');
    if (seen.has(v)) throw new Error('state-schema-invalid');
    seen.add(v);
    if (Array.isArray(v)) return v.map(function (x) { return stable(x, seen); });
    if (Object.prototype.toString.call(v) === '[object Date]') return v.toISOString();
    var proto = Object.getPrototypeOf(v);
    /* 跨 realm 的普通对象：其原型的原型为 null；这样不把 Node/浏览器对象误判为非法。 */
    if (proto !== null && Object.getPrototypeOf(proto) !== null) throw new Error('state-schema-invalid');
    var out = {};
    for (var k of Object.keys(v).sort()) out[k] = stable(v[k], seen);
    return out;
  }

  function canonicalState(s) {
    if (!s || typeof s !== 'object') throw new Error('state-schema-invalid');
    for (var k of Object.keys(s)) {
      if (PERSIST_KEYS.indexOf(k) < 0) throw new Error('state-schema-invalid');
    }
    var seen = new WeakSet();
    var parts = [];
    for (var key of PERSIST_KEYS) {
      if (key === 'stateEpoch') continue;           // epoch 由 commit 单独 +1
      var v = Object.prototype.hasOwnProperty.call(s, key) ? s[key] : null;
      if (v === undefined) throw new Error('state-schema-invalid');
      if (key === 'attempts' && Array.isArray(v)) {
        v = v.slice().sort(function (a, b) {
          return String(a && a.immutable && a.immutable.attemptId)
            .localeCompare(String(b && b.immutable && b.immutable.attemptId));
        });
      }
      parts.push([key, stable(v, seen)]);
    }
    return JSON.stringify(parts);
  }

  function stripRuntime(s) {
    if (!s || typeof s !== 'object') throw new Error('state-schema-invalid');
    var out = {};
    for (var k of Object.keys(s)) {
      if (PERSIST_KEYS.indexOf(k) < 0) throw new Error('state-schema-invalid');
      out[k] = s[k];
    }
    return out;
  }

  var api = Object.freeze({
    PERSIST_KEYS: Object.freeze(PERSIST_KEYS.slice()),
    encodeEnvelopeToBytes: encodeEnvelopeToBytes,
    sealPayloadBytes: sealPayloadBytes,
    objectKeyOf: objectKeyOf,
    canonicalImmutable: canonicalImmutable,
    makeImmutableHash: makeImmutableHash,
    verifyImmutableHash: verifyImmutableHash,
    deepFreeze: deepFreeze,
    assertImmutableShapeSync: assertImmutableShapeSync,
    makeAttemptIdentity: makeAttemptIdentity,
    assertPayloadRow: assertPayloadRow,
    canonicalState: canonicalState,
    stripRuntime: stripRuntime
  });

  global.OLBackupV2Core = api;
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
