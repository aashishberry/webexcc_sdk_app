import type {CallingRestCall} from './callingApi';

export type CallMatchResult =
  | {kind: 'matched'; call: CallingRestCall}
  | {kind: 'none'}
  | {kind: 'ambiguous'; candidates: CallingRestCall[]};

function normalizeNumber(value?: string): string {
  return (value ?? '').replace(/[^0-9A-Za-z@+]/g, '').toLowerCase();
}

function callId(call: CallingRestCall): string {
  return call.callId || call.id || '';
}

export function selectIncomingCall(
  calls: CallingRestCall[],
  expectedNumber = '',
  offeredAt = Date.now(),
): CallMatchResult {
  const candidates = calls.filter(
    (call) => callId(call) && call.personality === 'terminator' && call.state === 'alerting',
  );
  if (candidates.length === 0) return {kind: 'none'};
  if (candidates.length === 1) return {kind: 'matched', call: candidates[0]};

  const expected = normalizeNumber(expectedNumber);
  const scored = candidates
    .map((call) => {
      const remote = normalizeNumber(call.remoteParty?.number);
      const created = call.created ? Date.parse(call.created) : Number.NaN;
      const age = Number.isFinite(created) ? Math.abs(offeredAt - created) : 60_000;
      const numberScore = expected && remote && (remote === expected || remote.endsWith(expected)) ? 100 : 0;
      return {call, score: numberScore + Math.max(0, 30 - Math.floor(age / 1000))};
    })
    .sort((left, right) => right.score - left.score);

  if (scored[0].score > scored[1].score) return {kind: 'matched', call: scored[0].call};
  return {kind: 'ambiguous', candidates};
}

export function selectRecoverableCall(
  calls: CallingRestCall[],
  expectedNumber = '',
): CallMatchResult {
  const candidates = calls.filter(
    (call) =>
      callId(call) &&
      call.personality === 'terminator' &&
      ['alerting', 'connected', 'held', 'remoteHeld'].includes(call.state || ''),
  );
  if (candidates.length === 0) return {kind: 'none'};
  if (candidates.length === 1) return {kind: 'matched', call: candidates[0]};

  const expected = normalizeNumber(expectedNumber);
  if (expected) {
    const numberMatches = candidates.filter((call) => {
      const remote = normalizeNumber(call.remoteParty?.number);
      return remote && (remote === expected || remote.endsWith(expected) || expected.endsWith(remote));
    });
    if (numberMatches.length === 1) return {kind: 'matched', call: numberMatches[0]};
  }

  return {kind: 'ambiguous', candidates};
}
