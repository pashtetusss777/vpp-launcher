'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const analytics = require('./analytics');

function fakeSettings(initial = {}) {
  const data = { analytics: false, analyticsAsked: false, clientId: null, gpu: null, ...initial };
  return {
    data,
    get: () => data,
    update(patch) { Object.assign(data, patch); },
  };
}

const CONFIG = {
  analytics: { supabase: 'https://abcdefghijk.supabase.co', anonKey: 'public-anon-key-1234567890' },
};

test('only the project host with a real key becomes an endpoint', () => {
  assert.equal(analytics.endpoint(CONFIG).url, 'https://abcdefghijk.supabase.co/rest/v1/usage_events');
  assert.equal(analytics.endpoint({ analytics: { supabase: 'https://evil.example', anonKey: 'x'.repeat(30) } }), null);
  assert.equal(analytics.endpoint({ analytics: { supabase: 'http://abcdefghijk.supabase.co', anonKey: 'x'.repeat(30) } }), null);
  assert.equal(analytics.endpoint({ analytics: { supabase: 'https://abc.supabase.co.evil.example', anonKey: 'x'.repeat(30) } }), null);
  assert.equal(analytics.endpoint({ analytics: { supabase: 'https://abcdefghijk.supabase.co', anonKey: 'short' } }), null);
  assert.equal(analytics.endpoint({}), null);
});

test('the client id is created once and stays stable', () => {
  const settings = fakeSettings();
  const first = analytics.clientId(settings);
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal(analytics.clientId(settings), first);
  assert.equal(analytics.clientId(fakeSettings({ clientId: 'not-a-uuid' })).length, 36);
});

test('the discrete adapter wins over an integrated one', () => {
  const intel = 'Intel(R) UHD Graphics';
  const nvidia = 'NVIDIA GeForce RTX 4060 Laptop GPU';
  const radeonIGPU = 'AMD Radeon(TM) Graphics';
  const radeonDGPU = 'AMD Radeon RX 7600M XT';
  assert.equal(analytics.pickGpu([intel, nvidia]), nvidia);
  assert.equal(analytics.pickGpu([nvidia, intel]), nvidia);
  assert.equal(analytics.pickGpu([intel, radeonIGPU]), intel);
  assert.equal(analytics.pickGpu([radeonIGPU, radeonDGPU]), radeonDGPU);
  assert.equal(analytics.pickGpu([intel]), intel);
  assert.equal(analytics.pickGpu([]), '');
  assert.equal(analytics.pickGpu(['  ', '', intel]), intel);
});

test('the gpu is asked once and then comes from settings', async () => {
  const settings = fakeSettings();
  let asks = 0;
  const detect = async () => { asks++; return '  NVIDIA   RTX  4060  '; };
  assert.equal(await analytics.gpuOf(settings, detect), 'NVIDIA RTX 4060');
  assert.equal(await analytics.gpuOf(settings, detect), 'NVIDIA RTX 4060');
  assert.equal(asks, 1);
  assert.equal(await analytics.gpuOf(fakeSettings({ gpu: '' }), detect), '');
  assert.equal(asks, 1);
});

test('launch and session rows carry the promised fields and nothing else', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return { ok: true };
  });
  const settings = fakeSettings({ analytics: true, clientId: '11111111-2222-3333-4444-555555555555', gpu: 'RTX 4060' });
  assert.equal(await analytics.gameStarted({
    config: CONFIG, settings, minecraft: '26.2', pack: '1.1.8.1', ramGb: 5.5,
  }), true);
  assert.equal(await analytics.gameEnded({
    config: CONFIG, settings, durationS: 1234.6, exitCode: 1, crashed: true,
  }), true);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, 'https://abcdefghijk.supabase.co/rest/v1/usage_events');
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.headers.apikey, CONFIG.analytics.anonKey);
    assert.equal(call.options.headers['User-Agent'].startsWith('VanillaPlusPlus/'), true);
  }
  const launch = JSON.parse(calls[0].options.body)[0];
  assert.equal(launch.event, 'launch');
  assert.equal(launch.client_id, '11111111-2222-3333-4444-555555555555');
  assert.equal(launch.ram_allocated_gb, 6);
  assert.equal(launch.gpu, 'RTX 4060');
  assert.equal(typeof launch.cpu_cores, 'number');
  assert.ok(launch.ram_gb > 0);
  assert.match(launch.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(Object.hasOwn(launch, 'duration_s'), false);
  const end = JSON.parse(calls[1].options.body)[0];
  assert.equal(end.event, 'session_end');
  assert.equal(end.duration_s, 1235);
  assert.equal(end.crashed, true);
  assert.equal(Object.hasOwn(end, 'gpu'), false);
});

test('without consent, without config or on a network error nothing is sent', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url, options }); throw new Error('offline'); });
  const settings = fakeSettings({ analytics: false });
  assert.equal(await analytics.gameStarted({ config: CONFIG, settings, minecraft: '26.2' }), false);
  assert.equal(await analytics.gameEnded({ config: CONFIG, settings, durationS: 1 }), false);
  assert.equal(await analytics.gameStarted({ config: {}, settings: fakeSettings({ analytics: true }), minecraft: '26.2' }), false);
  assert.equal(calls.length, 0, 'no consent or no config means no network at all');
  // Consented with a config: the attempt goes out once and a network failure is swallowed.
  assert.equal(await analytics.gameStarted({ config: CONFIG, settings: fakeSettings({ analytics: true, clientId: '11111111-2222-3333-4444-555555555555', gpu: 'x' }), minecraft: '26.2' }), false);
  assert.equal(calls.length, 1);
});
