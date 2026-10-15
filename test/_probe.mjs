
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
const root = process.argv[2];
const ids = ['instance-line','feed-meta','cards','error-text','state-setup','state-loading','state-error','feed-main'];
const elements = {};
const mk = (id) => ({ id, hidden: true, textContent: '', value: '', innerHTML: '', listeners: {},
  classList: { toggle(){}, add(){}, contains(){return false;} }, addEventListener(t,f){ (this.listeners[t] ||= []).push(f); } });
for (const id of ids) elements[id] = mk(id);
const store = {}; const requested = []; const dl = {};
const document = { getElementById: (i) => elements[i] ?? null, addEventListener: (t,f) => { (dl[t] ||= []).push(f); } };
const browser = { storage: { local: { get: async () => ({...store}), set: async (o) => Object.assign(store,o), remove: async (k) => { for (const x of [].concat(k)) delete store[x]; } } },
  runtime: { getURL: (p) => 'moz-extension://x/'+p }, tabs: { create(){} } };
const ctx = vm.createContext({ browser, document, console, getInstance: async () => 'https://lh.example',
  setInstance: async (v) => v, URL, Date, JSON, Object, Array, String, Number, Math, Promise, RegExp, Error, Set, Map, setTimeout,
  fetch: async (url) => { requested.push(String(url)); const b = String(url);
    if (/\/api\/v1\/discovery(\?|$)/.test(b)) return { ok: true, status: 200, json: async () => ({ items: [{work_id:'a',slot_id:'slot-a'},{work_id:'b',slot_id:'slot-b'}], sort: 'for_you', request_id: 'r1' }) };
    if (/\/api\/v1\/works\/a/.test(b)) return { ok: true, status: 200, json: async () => ({ id:'a', title:'Work a', completion:'complete', metrics:{kudos:1,views:2,bookmarks:0}, authors:[{handle:'x'}], chapters:[{word_count:10}] }) };
    if (/explanation/.test(b)) return { ok: true, status: 200, json: async () => ({ slot_id:'slot-a', reasons:[{text:'because you read slow burns'}], blend_score: 900, served_at:'x' }) };
    if (/history/.test(b)) return { ok: true, status: 200, json: async () => ({ items: [{work_id:'a'}] }) };
    return { ok: false, status: 404, json: async () => ({error:'no stub'}) }; } });
for (const f of ['lorehaven.js','cache.js','feed-model.js','feed-page.js']) vm.runInContext(readFileSync(join(root,f),'utf8'), ctx, { filename: f });
for (const fn of (dl.DOMContentLoaded || [])) await fn();
for (let i=0;i<40;i++) await new Promise(r=>setTimeout(r,0));
console.log('META:', JSON.stringify(elements['feed-meta'].textContent));
console.log('CARDS:', elements['cards'].innerHTML.slice(0,150));
console.log('REQ:', requested);
