// Market-session timezones for SlotConfigDrawer's per-window TZ picker.
//
// Source of truth = tv-broker-relay/frontend/src/lib/marketSessions.js.
// Mirrored here (label + tz only) so the UI doesn't need to fetch from
// the relay just to populate a dropdown. The list is stable; sync if
// the relay adds / drops a session.
//
// IANA TZ names (not abbreviations) so the runner can use them with a
// real tzdata lookup -- engine consumers should never assume EST/EDT
// from a string like "ET", they should resolve "America/New_York" via
// the system tzdb so DST flips happen correctly.
export const MARKET_SESSIONS = [
  { label: 'SYD', tz: 'Australia/Sydney',     desc: 'Sydney' },
  { label: 'TYO', tz: 'Asia/Tokyo',           desc: 'Tokyo' },
  { label: 'HKG', tz: 'Asia/Hong_Kong',       desc: 'Hong Kong' },
  { label: 'FRA', tz: 'Europe/Berlin',        desc: 'Frankfurt' },
  { label: 'LON', tz: 'Europe/London',        desc: 'London' },
  { label: 'NYC', tz: 'America/New_York',     desc: 'New York' },
  { label: 'CME', tz: 'America/Chicago',      desc: 'CME Chicago' },
];

// Default for new session windows -- NY ET is what xovdDefaultSessions()
// historically used (per the comment in backtester/runtime/sessionMask.h)
// so existing configs stay in the same TZ on first edit.
export const DEFAULT_MARKET_TZ = 'America/New_York';
