import assert from 'node:assert';
function ageMs(ts, now){ if(!ts) return Infinity; const t=Date.parse(ts); return Number.isFinite(t)?now-t:Infinity; }
function shouldRestart(h, now, cfg={}){
  const maxZaloEventAgeMs=cfg.maxZaloEventAgeMs ?? 3*60*60_000;
  const minZaloRuntimeBeforeStaleMs=cfg.minZaloRuntimeBeforeStaleMs ?? 30*60_000;
  const maxTgActiveAgeMs=cfg.maxTgActiveAgeMs ?? 30*60_000;
  const maxBidirectionalSilenceMs=cfg.maxBidirectionalSilenceMs ?? 3*60*60_000;
  const activeStartHour=cfg.activeStartHour ?? 8;
  const activeEndHour=cfg.activeEndHour ?? 23;
  const zaloStartedAge=ageMs(h.zaloStartedAt||h.startedAt,now);
  const zaloEventAge=ageMs(h.lastZaloEventAt||h.lastZaloToTgSuccessAt,now);
  const tgActiveAge=Math.min(ageMs(h.lastTelegramUpdateAt,now),ageMs(h.lastTgToZaloSuccessAt,now));
  const hasZaloEverWorked=!!(h.lastZaloEventAt||h.lastZaloToTgSuccessAt);
  const hasTelegramEverWorked=!!(h.lastTelegramUpdateAt||h.lastTgToZaloSuccessAt);
  const tgSideActive=Number.isFinite(tgActiveAge)&&tgActiveAge<=maxTgActiveAgeMs;
  const zaloWarmEnough=Number.isFinite(zaloStartedAge)&&zaloStartedAge>=minZaloRuntimeBeforeStaleMs;
  const localHour=new Date(now).getHours();
  const inActiveHours=activeStartHour<=activeEndHour ? (localHour>=activeStartHour&&localHour<=activeEndHour) : (localHour>=activeStartHour||localHour<=activeEndHour);
  const bothDirectionsSilent=hasTelegramEverWorked&&hasZaloEverWorked&&tgActiveAge>maxBidirectionalSilenceMs&&zaloEventAge>maxBidirectionalSilenceMs;
  if(zaloWarmEnough&&inActiveHours&&bothDirectionsSilent) return 'bidirectional-half-dead';
  if(hasZaloEverWorked&&zaloWarmEnough&&tgSideActive&&zaloEventAge>maxZaloEventAgeMs) return 'zalo-listener-stale';
  return false;
}
const now=Date.parse('2026-06-02T04:02:54.442Z');
assert.strictEqual(shouldRestart({startedAt:'2026-05-31T06:34:18.049Z',zaloStartedAt:'2026-05-31T06:34:18.794Z',lastTelegramUpdateAt:'2026-06-02T04:02:51.215Z',lastTgToZaloSuccessAt:'2026-06-02T04:02:51.240Z',lastZaloEventAt:'2026-06-01T17:52:03.292Z',lastZaloToTgSuccessAt:'2026-06-01T17:52:14.693Z'}, now), 'zalo-listener-stale', 'old one-way incident must restart');
assert.strictEqual(shouldRestart({startedAt:'2026-06-02T04:00:00.000Z',zaloStartedAt:'2026-06-02T04:00:00.000Z',lastTelegramUpdateAt:'2026-06-02T04:02:51.000Z'}, now), false, 'fresh boot no false restart');
assert.strictEqual(shouldRestart({startedAt:'2026-05-31T00:00:00.000Z',zaloStartedAt:'2026-05-31T00:00:00.000Z',lastTelegramUpdateAt:'2026-06-01T00:00:00.000Z',lastZaloEventAt:'2026-06-01T17:52:03.292Z'}, now, {activeStartHour:20, activeEndHour:23}), false, 'outside active hours no bidirectional restart');
assert.strictEqual(shouldRestart({startedAt:'2026-05-31T00:00:00.000Z',zaloStartedAt:'2026-05-31T00:00:00.000Z',lastTelegramUpdateAt:'2026-06-02T04:02:51.000Z',lastZaloEventAt:'2026-06-02T03:00:00.000Z'}, now), false, 'recent Zalo event no restart');
const incidentNow=Date.parse('2026-06-09T02:56:00.000Z'); // 09:56 Asia/Bangkok
assert.strictEqual(shouldRestart({startedAt:'2026-06-09T00:00:00.000Z',zaloStartedAt:'2026-06-09T00:00:00.000Z',updatedAt:'2026-06-09T02:55:30.000Z',lastTelegramUpdateAt:'2026-06-08T17:15:00.000Z',lastZaloEventAt:'2026-06-08T18:41:00.000Z',lastZaloToTgSuccessAt:'2026-06-08T18:41:00.000Z'}, incidentNow), 'bidirectional-half-dead', '2026-06-09 both-directions stale incident must restart');
assert.strictEqual(shouldRestart({startedAt:'2026-06-18T01:01:05.088Z',zaloStartedAt:'2026-06-18T01:01:05.822Z',lastZaloEventAt:'2026-06-18T01:01:25.000Z'}, Date.parse('2026-06-18T01:02:48.000Z')), false, 'missing Telegram timestamps must not become year-2000 phantom age');
assert.strictEqual(shouldRestart({startedAt:'2026-06-18T01:01:05.088Z',zaloStartedAt:'2026-06-18T01:01:05.822Z',lastTelegramUpdateAt:'2026-06-17T18:18:30.000Z',lastZaloEventAt:'2026-06-17T19:38:40.000Z',lastZaloToTgSuccessAt:'2026-06-17T19:38:41.000Z'}, Date.parse('2026-06-18T08:00:48.000Z'), {activeStartHour:1, activeEndHour:23}), 'bidirectional-half-dead', '2026-06-18 active-hours both-directions stale must restart');
console.log('unit-watchdog-zalo-stale: OK');
