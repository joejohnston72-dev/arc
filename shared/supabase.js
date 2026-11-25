// Pinned to an exact version: `@2` silently pulled in every new 2.x release.
// sw.js caches this URL (and the files it imports) so the app opens offline.
// When bumping, change SUPABASE_JS in sw.js too.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm';

// Exported so other modules (e.g. the coach proxy in workout/coach.js) can derive
// the Edge Function URL and send the anon key without re-hardcoding these.
export const SUPABASE_URL = 'https://xjcnkivlkfzdycbyxxlx.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqY25raXZsa2Z6ZHljYnl4eGx4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0MjQwODIsImV4cCI6MjA5NjAwMDA4Mn0.bt4X0cz2gu7GUdb8OC7uvVLPDKJWws8RyvSmwGkHcVI';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
