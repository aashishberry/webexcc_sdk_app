import {describe, expect, it} from 'vitest';
import {selectIncomingCall, selectRecoverableCall} from './callMatching';

describe('selectIncomingCall', () => {
  it('selects the only alerting terminator call', () => {
    const result = selectIncomingCall([
      {callId: 'incoming', personality: 'terminator', state: 'alerting'},
      {callId: 'outgoing', personality: 'originator', state: 'connecting'},
    ]);
    expect(result).toMatchObject({kind: 'matched', call: {callId: 'incoming'}});
  });

  it('uses the remote party number to disambiguate calls', () => {
    const result = selectIncomingCall(
      [
        {
          callId: 'one',
          personality: 'terminator',
          state: 'alerting',
          remoteParty: {number: '+1 (407) 555-1111'},
        },
        {
          callId: 'two',
          personality: 'terminator',
          state: 'alerting',
          remoteParty: {number: '+1 (407) 555-2222'},
        },
      ],
      '+14075552222',
    );
    expect(result).toMatchObject({kind: 'matched', call: {callId: 'two'}});
  });

  it('does not guess when candidates have equal evidence', () => {
    const result = selectIncomingCall([
      {callId: 'one', personality: 'terminator', state: 'alerting'},
      {callId: 'two', personality: 'terminator', state: 'alerting'},
    ]);
    expect(result.kind).toBe('ambiguous');
  });
});

describe('selectRecoverableCall', () => {
  it('restores a connected inbound call after a refresh', () => {
    const result = selectRecoverableCall([
      {callId: 'active', personality: 'terminator', state: 'connected'},
    ]);
    expect(result).toMatchObject({kind: 'matched', call: {callId: 'active'}});
  });

  it('uses the caller number without guessing between multiple active calls', () => {
    const result = selectRecoverableCall(
      [
        {callId: 'one', personality: 'terminator', state: 'held', remoteParty: {number: '1001'}},
        {callId: 'two', personality: 'terminator', state: 'connected', remoteParty: {number: '1002'}},
      ],
      '1002',
    );
    expect(result).toMatchObject({kind: 'matched', call: {callId: 'two'}});
  });
});
