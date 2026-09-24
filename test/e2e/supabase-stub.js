// Test double for shared/supabase.js. Routed in by Playwright so the app boots
// signed-in with no network: the real module pulls the SDK from a CDN and every
// sync call would hit Supabase.
const session = { user: { id: 'test-user', email: 'test@example.com' }, access_token: 'test-token' };
const emptyQuery = {
  select() { return this; }, eq() { return this; }, order() { return this; },
  range() { return Promise.resolve({ data: [], error: null }); },
  upsert() { return Promise.resolve({ data: null, error: null }); },
  delete() { return this; },
  then(res) { return Promise.resolve({ data: [], error: null }).then(res); },
};
export const SUPABASE_URL = 'https://stub.invalid';
export const SUPABASE_ANON_KEY = 'stub';
export const supabase = {
  auth: {
    getSession: () => Promise.resolve({ data: { session }, error: null }),
    getUser:    () => Promise.resolve({ data: { user: session.user }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut:    () => Promise.resolve({ error: null }),
  },
  from: () => emptyQuery,
};
