/**
 * End-to-end integration test.
 *
 * Runs the REAL server (src/server.js) with the network stubbed:
 *   - Requests to api.anthropic.com  -> scripted Claude responses (tool_use / end_turn)
 *   - Requests to the Housecall Pro base -> canned fixtures (and recorded)
 *   - Requests to our own test server    -> the original (real) fetch
 *
 * This validates the full flow: HTTP endpoints, auth gate, the Claude tool-use
 * loop, read-tool execution, and — critically — that write tools do NOT touch
 * Housecall Pro until the user confirms.
 *
 * No real API keys required. Run: npm test
 */

// --- Env must be set before importing the app ------------------------------
process.env.ANTHROPIC_API_KEY = 'test-anthropic';
process.env.HOUSECALL_API_KEY = 'test-hcp';
process.env.HOUSECALL_API_BASE = 'https://hcp.test';
process.env.APP_PASSWORD = 'secret';
process.env.PORT = '3222';

const BASE = 'http://127.0.0.1:3222';
const originalFetch = globalThis.fetch.bind(globalThis);

// --- Network stubs ----------------------------------------------------------
let anthropicQueue = [];
let anthropicIndex = 0;
const hcpCalls = [];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req_test' },
  });
}

function aiToolUse(name, input, text = '') {
  return {
    id: 'msg_' + Math.random().toString(36).slice(2),
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-8',
    stop_reason: 'tool_use',
    stop_sequence: null,
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      { type: 'tool_use', id: 'tu_' + Math.random().toString(36).slice(2), name, input },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function aiText(text) {
  return {
    id: 'msg_' + Math.random().toString(36).slice(2),
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-8',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function hcpFixture(method, path) {
  if (method === 'GET' && path === '/jobs') {
    return {
      jobs: [
        { id: 'job_1', description: 'AC tune-up', scheduled_start: '2026-07-01T09:00:00Z' },
        { id: 'job_2', description: 'Furnace inspection', scheduled_start: '2026-07-01T13:00:00Z' },
      ],
      total_items: 2,
    };
  }
  if (method === 'GET' && path === '/invoices') {
    return {
      invoices: [
        { id: 'inv_1', status: 'paid', amount_due: 0 },
        { id: 'inv_2', status: 'open', amount_due: 250 },
        { id: 'inv_3', status: 'unpaid', amount_due: 100 },
      ],
      total_items: 3,
    };
  }
  if (method === 'GET' && path === '/estimates') {
    return {
      estimates: [
        { id: 'est_1', status: 'approved', approved_at: '2026-06-01T00:00:00Z' },
        { id: 'est_2', status: 'pending' },
        { id: 'est_3', status: 'sent' },
      ],
      total_items: 3,
    };
  }
  if (method === 'POST' && path === '/jobs') return { id: 'job_new', work_status: 'scheduled' };
  if (method === 'POST' && path === '/estimates') return { id: 'est_new', status: 'draft' };
  return {};
}

globalThis.fetch = async (input, init = {}) => {
  const urlStr = typeof input === 'string' ? input : input.url || String(input);
  const u = new URL(urlStr);

  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
    return originalFetch(input, init); // our own test server
  }
  if (u.hostname.includes('anthropic')) {
    const next = anthropicQueue[anthropicIndex++];
    if (!next) throw new Error(`No scripted Anthropic response #${anthropicIndex}`);
    return jsonResponse(next);
  }
  if (u.hostname === 'hcp.test') {
    const method = (init.method || 'GET').toUpperCase();
    hcpCalls.push({ method, path: u.pathname, body: init.body ? JSON.parse(init.body) : undefined });
    return jsonResponse(hcpFixture(method, u.pathname));
  }
  throw new Error('Unexpected fetch: ' + urlStr);
};

// --- Tiny assertion helpers -------------------------------------------------
let passed = 0;
const failures = [];
function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function api(path, body, { auth = true, sessionId = 'sess-default' } = {}) {
  const headers = { 'content-type': 'application/json', 'x-session-id': sessionId };
  if (auth) headers['x-app-password'] = 'secret';
  return originalFetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body) }).then(
    async (r) => ({ status: r.status, json: await r.json() }),
  );
}

// --- Run --------------------------------------------------------------------
await import('../src/server.js');
await sleep(400);

try {
  // Scenario A: read (schedule) --------------------------------------------
  console.log('\n[A] Read: schedule');
  anthropicQueue = [
    aiToolUse('get_schedule', { scheduled_start_min: '2026-07-01', scheduled_start_max: '2026-07-01' }),
    aiText('You have 2 jobs today: an AC tune-up at 9am and a furnace inspection at 1pm.'),
  ];
  anthropicIndex = 0;
  hcpCalls.length = 0;
  let r = await api('/api/chat', { message: "What's on the schedule today?" }, { sessionId: 'A' });
  check('A: 200 OK', r.status === 200);
  check('A: type=message', r.json.type === 'message');
  check('A: text returned', typeof r.json.text === 'string' && r.json.text.length > 0);
  check('A: called GET /jobs', hcpCalls.some((c) => c.method === 'GET' && c.path === '/jobs'));

  // Scenario B: write + CONFIRM ---------------------------------------------
  console.log('\n[B] Write create_job with confirm');
  anthropicQueue = [
    aiToolUse('create_job', { customer_id: 'cust_123', scheduled_start: '2026-07-02T09:00:00Z', description: 'Replace capacitor' }, "I'll create that job."),
    aiText('Done — job job_new is scheduled for tomorrow at 9am.'),
  ];
  anthropicIndex = 0;
  hcpCalls.length = 0;
  r = await api('/api/chat', { message: 'Create a job for cust_123 tomorrow 9am to replace the capacitor.' }, { sessionId: 'B' });
  check('B: chat returns confirm', r.json.type === 'confirm');
  check('B: action is create_job', r.json.actions?.[0]?.tool === 'create_job');
  check('B: has a human summary', typeof r.json.actions?.[0]?.summary === 'string');
  check('B: NO write before confirm', !hcpCalls.some((c) => c.method === 'POST'));

  const rc = await api('/api/confirm', { approved: true }, { sessionId: 'B' });
  check('B: confirm returns message', rc.json.type === 'message');
  const postJob = hcpCalls.find((c) => c.method === 'POST' && c.path === '/jobs');
  check('B: POST /jobs after confirm', Boolean(postJob));
  check('B: correct customer_id sent', postJob?.body?.customer_id === 'cust_123');

  // Scenario C: write + CANCEL ----------------------------------------------
  console.log('\n[C] Write create_estimate with cancel');
  anthropicQueue = [
    aiToolUse('create_estimate', { customer_id: 'cust_999', description: 'New AC unit' }),
    aiText('No problem — I did not create the estimate.'),
  ];
  anthropicIndex = 0;
  hcpCalls.length = 0;
  r = await api('/api/chat', { message: 'Draft an estimate for cust_999 for a new AC.' }, { sessionId: 'C' });
  check('C: chat returns confirm', r.json.type === 'confirm');
  const rcancel = await api('/api/confirm', { approved: false }, { sessionId: 'C' });
  check('C: cancel returns message', rcancel.json.type === 'message');
  check('C: NO estimate written on cancel', !hcpCalls.some((c) => c.method === 'POST' && c.path === '/estimates'));

  // Scenario D: auth gate ----------------------------------------------------
  console.log('\n[D] Auth gate');
  const noauth = await api('/api/chat', { message: 'hi' }, { auth: false, sessionId: 'D' });
  check('D: 401 without password', noauth.status === 401);

  // Scenario E: read-tool filtering (unit-level via the running server) ------
  console.log('\n[E] Filtering: unpaid invoices / unsigned estimates');
  const { toolsByName } = await import('../src/tools.js');
  const unpaid = await toolsByName['list_unpaid_invoices'].execute({});
  check('E: unpaid excludes paid invoice', !unpaid.items.some((i) => i.id === 'inv_1'));
  check('E: unpaid includes open + unpaid', unpaid.items.some((i) => i.id === 'inv_2') && unpaid.items.some((i) => i.id === 'inv_3'));
  const unsigned = await toolsByName['list_unsigned_estimates'].execute({});
  check('E: unsigned excludes approved', !unsigned.items.some((e) => e.id === 'est_1'));
  check('E: unsigned includes pending + sent', unsigned.items.some((e) => e.id === 'est_2') && unsigned.items.some((e) => e.id === 'est_3'));

  // Scenario F: HCP auth header ---------------------------------------------
  console.log('\n[F] Housecall Pro auth header');
  let sawAuthHeader = false;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const urlStr = typeof input === 'string' ? input : input.url || String(input);
    if (urlStr.includes('hcp.test')) {
      const h = new Headers(init.headers);
      sawAuthHeader = h.get('authorization') === 'Token test-hcp';
    }
    return savedFetch(input, init);
  };
  await toolsByName['list_customers'].execute({ q: 'smith' });
  globalThis.fetch = savedFetch;
  check('F: sends "Authorization: Token <key>"', sawAuthHeader);
} catch (err) {
  failures.push('EXCEPTION: ' + err.message);
  console.error(err);
}

console.log(`\n${passed} checks passed, ${failures.length} failed.`);
if (failures.length) {
  console.log('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log('ALL GOOD ✅');
process.exit(0);
