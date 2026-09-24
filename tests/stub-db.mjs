// Test-only loader hook: shared/db.js pulls Supabase from a CDN URL and opens
// IndexedDB at import, neither of which exists in Node. Swap it for an in-memory
// stub so the pure modules that import it (achievements.js) load instantly.
import { register } from 'node:module';

const STUB = `
const mem = new Map();
const k = (s, id) => s + '/' + id;
const db = {
  get: async (s, id) => mem.get(k(s, id)),
  set: async (s, id, v) => { mem.set(k(s, id), v); },
};
export const initialSync = Promise.resolve(0);
export default db;
`;

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier.endsWith('/shared/db.js')) {
    return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(STUB)}), shortCircuit: true };
  }
  return next(specifier, context);
}
`));
