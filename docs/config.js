// Fill in the two values from Supabase → Project Settings → API.
// The anon key is meant to be public: what it can read is controlled by the Row Level Security policies in schema.sql.
// NEVER put the service_role key here.
window.APP_CONFIG = {
  SUPABASE_URL: "https://jxpnamaomzztqqahixvp.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4cG5hbWFvbXp6dHFxYWhpeHZwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5ODQyNjgsImV4cCI6MjEwNzU2MDI2OH0.ekpFsnfvLIbuW1dDnrb5SawjFYBTtRQbsyQnAyJinCA",

  // true  = private: sign in with an emailed link (matches schema.sql Option A, the default)
  // false = anyone with the page URL can read (matches schema.sql Option B)
  REQUIRE_LOGIN: true,

  // Warn when the newest data is older than this many days (weekends included).
  STALE_AFTER_DAYS: 4,
};
