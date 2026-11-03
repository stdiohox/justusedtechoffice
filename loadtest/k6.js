// Load test (k6: https://grafana.com/docs/k6/). Read-only: GETs, no writes, no emails.
//
//   k6 run loadtest/k6.js                                   the shell and its bundle (CDN)
//   BASE_URL=https://<preview>.vercel.app k6 run loadtest/k6.js
//
// With a signed-in user's access token it also runs the office's own reads the way the
// app does (RLS applies, so it sees what that user sees):
//
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=... ACCESS_TOKEN=... k6 run loadtest/k6.js
//
// The token is the `access_token` in localStorage (sb-<ref>-auth-token) after signing in.
// VUS and DURATION override the defaults (10 users, 1 minute). Fails if p95 or errors
// cross the thresholds below.
import http from 'k6/http'
import { check, sleep } from 'k6'

const BASE = __ENV.BASE_URL || 'https://office.justusedtech.org'
const SB = __ENV.SUPABASE_URL
const KEY = __ENV.SUPABASE_ANON_KEY
const TOKEN = __ENV.ACCESS_TOKEN
const db = SB && KEY && TOKEN

export const options = {
  vus: Number(__ENV.VUS || 10),
  duration: __ENV.DURATION || '1m',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{kind:web}': ['p(95)<800'],
    // The bundle's time is mostly the connection, so the bar is looser.
    'http_req_duration{kind:asset}': ['p(95)<2000'],
    ...(db ? { 'http_req_duration{kind:db}': ['p(95)<800'] } : {}),
  },
}

export function setup() {
  const html = http.get(`${BASE}/`).body || ''
  const asset = (html.match(/\/assets\/index-[\w-]+\.js/) || [])[0]
  return { asset }
}

const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

export default function ({ asset }) {
  const page = http.get(`${BASE}/`, { tags: { kind: 'web' } })
  check(page, { 'shell 200': (r) => r.status === 200 })
  if (asset) {
    const js = http.get(`${BASE}${asset}`, { tags: { kind: 'asset' } })
    check(js, { 'bundle 200': (r) => r.status === 200, 'bundle immutable': (r) => /immutable/.test(r.headers['Cache-Control'] || '') })
  }

  if (db) {
    const headers = { apikey: KEY, Authorization: `Bearer ${TOKEN}` }
    const q = (path) => http.get(`${SB}/rest/v1/${path}`, { headers, tags: { kind: 'db' } })
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString()
    const reads = [
      q(`office_tasks?select=*&or=(closed_at.is.null,closed_at.gte.${since})&order=updated_at.desc&limit=1000`),
      q(`office_entries?select=id,user_id,work_date,entered_at,left_at&work_date=eq.${day(0)}&order=id`),
      q(`office_reports?select=id,user_id,work_date,kind&work_date=gte.${day(-7)}&work_date=lte.${day(0)}`),
      q(`office_day_notes?select=id,user_id,work_date,body,created_at&work_date=gte.${day(-7)}&work_date=lte.${day(0)}&order=created_at`),
    ]
    for (const r of reads) check(r, { 'read 200': (x) => x.status === 200 })
  }
  sleep(1)
}
