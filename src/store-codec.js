// Shared by the server bundle and the cloud manager page (/manager/store-codec.js).
// A teacher's data object is stored as many small records instead of one blob:
//   ['#o','']        top-level field order  {t:'top',ids:[field names]}
//   ['#o',name]      order of a collection  {t:'a'|'o',ids:[item ids or keys]}
//   ['i:'+name,id]   one item of an array (by item.id) or one entry of an object
//   ['#f',name]      a field kept whole (scalars, arrays without unique ids, ...)
// storeDecode(storeEncode(x)) deep-equals x for any JSON value x that is an object.
'use strict';
const STORE_SEP = '\u0001';
const storeKey = (coll, rid) => coll + STORE_SEP + rid;
const storeSplit = key => { const i = key.indexOf(STORE_SEP); return [key.slice(0, i), key.slice(i + 1)]; };
const storePlain = x => !!x && typeof x === 'object' && !Array.isArray(x);
const storeIdOk = id => typeof id === 'string' && id.length > 0 && id.length <= 200 && !id.includes(STORE_SEP);
function storeDefine(target, key, value) {
  Object.defineProperty(target, key, {value, enumerable: true, writable: true, configurable: true});
}
function storeEncode(data) {
  const out = new Map(), names = Object.keys(data);
  out.set(storeKey('#o', ''), JSON.stringify({t: 'top', ids: names}));
  for (const name of names) {
    const value = data[name];
    if (name === '') out.set(storeKey('#f', name), JSON.stringify(value === undefined ? null : value));
    else if (Array.isArray(value) && value.every(x => storePlain(x) && storeIdOk(x.id)) && new Set(value.map(x => x.id)).size === value.length) {
      out.set(storeKey('#o', name), JSON.stringify({t: 'a', ids: value.map(x => x.id)}));
      for (const item of value) out.set(storeKey('i:' + name, item.id), JSON.stringify(item));
    } else if (storePlain(value) && Object.keys(value).every(k => k.length <= 200 && !k.includes(STORE_SEP))) {
      const ids = Object.keys(value);
      out.set(storeKey('#o', name), JSON.stringify({t: 'o', ids}));
      for (const id of ids) out.set(storeKey('i:' + name, id), JSON.stringify(value[id]));
    } else {
      out.set(storeKey('#f', name), JSON.stringify(value === undefined ? null : value));
    }
  }
  return out;
}
// entries: iterable of [coll, rid, jsonText]
function storeDecode(entries) {
  let top = null;
  const orders = new Map(), fields = new Map(), items = new Map();
  for (const [coll, rid, text] of entries) {
    if (coll === '#o') { if (rid === '') top = JSON.parse(text); else orders.set(rid, JSON.parse(text)); }
    else if (coll === '#f') fields.set(rid, text);
    else if (coll.startsWith('i:')) {
      const name = coll.slice(2);
      if (!items.has(name)) items.set(name, new Map());
      items.get(name).set(rid, text);
    }
  }
  const names = [], seenNames = new Set();
  for (const name of [...(top?.ids || []), ...orders.keys(), ...fields.keys()]) {
    if (!seenNames.has(name)) { seenNames.add(name); names.push(name); }
  }
  const data = {};
  for (const name of names) {
    const order = orders.get(name), list = items.get(name) || new Map();
    if (order) {
      const ids = order.ids.filter(id => list.has(id)), seen = new Set(ids);
      for (const id of list.keys()) if (!seen.has(id)) ids.push(id);
      if (order.t === 'a') storeDefine(data, name, ids.map(id => JSON.parse(list.get(id))));
      else { const value = {}; for (const id of ids) storeDefine(value, id, JSON.parse(list.get(id))); storeDefine(data, name, value); }
    } else if (fields.has(name)) storeDefine(data, name, JSON.parse(fields.get(name)));
  }
  return data;
}
// Records that differ between two encodings: [[key, jsonText|null], ...]
function storeDiff(prev, next) {
  const out = [];
  for (const [key, text] of next) if (prev.get(key) !== text) out.push([key, text]);
  for (const key of prev.keys()) if (!next.has(key)) out.push([key, null]);
  return out;
}
