// Minimal Firestore REST client for Workers (no Node SDK): get, query, atomic commit with preconditions.

export function encode(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.filter(x => x !== undefined).map(encode) } };
  if (typeof v === 'object') return { mapValue: { fields: toFields(v) } };
  throw new Error(`cannot encode ${typeof v}`);
}
export const toFields = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, encode(v)]));

export function decode(v) {
  if (!v || 'nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
  if ('mapValue' in v) return fromFields(v.mapValue.fields);
  if ('referenceValue' in v) return v.referenceValue;
  return null;
}
export const fromFields = f => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, decode(v)]));

export class Conflict extends Error {}

export class Firestore {
  constructor(projectId, getToken, fetchFn = (...a) => fetch(...a)) {
    this.root = `projects/${projectId}/databases/(default)/documents`;
    this.base = `https://firestore.googleapis.com/v1/${this.root}`;
    this.getToken = getToken;
    this.fetch = fetchFn;
  }
  name(path) { return `${this.root}/${path}`; }

  async req(url, body, method = body ? 'POST' : 'GET') {
    const res = await this.fetch(url, { method, headers: { Authorization: `Bearer ${await this.getToken()}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
    if (res.status === 404 && method === 'GET') return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const status = data?.error?.status || '';
      if (status === 'FAILED_PRECONDITION' || status === 'ALREADY_EXISTS' || status === 'ABORTED' || (status === 'NOT_FOUND' && method === 'POST')) throw new Conflict(status);
      throw new Error(`Firestore ${res.status} ${status}: ${data?.error?.message || ''}`);
    }
    return data;
  }

  // → { id, data, updateTime } or null
  async get(path) {
    const d = await this.req(`${this.base}/${path}`);
    return d ? { id: path.split('/').pop(), data: fromFields(d.fields), updateTime: d.updateTime } : null;
  }

  // equality filters only: [['field', value], ...]
  async where(parentPath, collectionId, filters) {
    const ff = filters.map(([f, v]) => ({ fieldFilter: { field: { fieldPath: f }, op: 'EQUAL', value: encode(v) } }));
    const where = ff.length === 1 ? ff[0] : { compositeFilter: { op: 'AND', filters: ff } };
    const rows = await this.req(`${this.base}/${parentPath}:runQuery`, { structuredQuery: { from: [{ collectionId }], where } });
    return (rows || []).filter(r => r.document).map(r => ({ id: r.document.name.split('/').pop(), data: fromFields(r.document.fields), updateTime: r.document.updateTime }));
  }

  // writes are applied atomically; returns writeResults
  async commit(writes) {
    const d = await this.req(`https://firestore.googleapis.com/v1/${this.root}:commit`, { writes });
    return d.writeResults || [];
  }

  // ---- write builders ----
  set(path, data) { return { update: { name: this.name(path), fields: toFields(data) } }; }
  create(path, data) { return { ...this.set(path, data), currentDocument: { exists: false } }; }
  // patch only the given fields; updateTime makes it fail if the doc changed since it was read
  patch(path, data, updateTime) {
    return { update: { name: this.name(path), fields: toFields(data) }, updateMask: { fieldPaths: Object.keys(data) },
      currentDocument: updateTime ? { updateTime } : { exists: true } };
  }
  // merge fields and add numbers (creates the doc if missing)
  mergeIncrement(path, data, inc) {
    return { update: { name: this.name(path), fields: toFields(data) }, updateMask: { fieldPaths: Object.keys(data) },
      updateTransforms: Object.entries(inc).map(([fieldPath, n]) => ({ fieldPath, increment: encode(n) })) };
  }
  increment(path, field, n = 1) {
    return { transform: { document: this.name(path), fieldTransforms: [{ fieldPath: field, increment: encode(n) }] } };
  }
}

// read → check → write, retried when the document changed in between
export async function withRetry(fn, tries = 4) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) { if (!(e instanceof Conflict) || i >= tries - 1) throw e; }
  }
}
