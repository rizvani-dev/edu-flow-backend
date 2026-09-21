const { createClient } = require('@supabase/supabase-js');

const stripWrappingQuotes = (value) =>
  String(value || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '');

const deriveSupabaseUrlFromDatabaseUrl = () => {
  const rawDatabaseUrl = stripWrappingQuotes(process.env.DATABASE_URL);
  if (!rawDatabaseUrl) return '';

  try {
    const parsed = new URL(rawDatabaseUrl);
    const match = parsed.hostname.match(/^db\.([^.]+)\.supabase\.co$/i);
    return match ? `https://${match[1]}.supabase.co` : '';
  } catch {
    return '';
  }
};

const supabaseUrl =
  stripWrappingQuotes(process.env.SUPABASE_URL) || deriveSupabaseUrlFromDatabaseUrl();
const supabaseServiceRoleKey =
  stripWrappingQuotes(process.env.SUPABASE_SERVICE_ROLE_KEY) ||
  stripWrappingQuotes(process.env.SUPABASE_ANON_KEY);
const supabaseBucket = stripWrappingQuotes(process.env.SUPABASE_STORAGE_BUCKET) || 'school-manager';

const isSupabaseConfigured = Boolean(supabaseUrl && supabaseServiceRoleKey && supabaseBucket);

const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

module.exports = {
  supabase,
  supabaseBucket,
  supabaseUrl,
  isSupabaseConfigured,
};
