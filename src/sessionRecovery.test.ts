// @vitest-environment jsdom

import {beforeEach, describe, expect, it} from 'vitest';
import type {Profile} from '@webex/contact-center';
import {
  clearRecoveryIntent,
  readRecoveryIntent,
  recoveredAgentSession,
  saveRecoveryIntent,
} from './sessionRecovery';

describe('refresh recovery intent', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('persists station preferences without persisting the OAuth token', () => {
    saveRecoveryIntent({
      loginOption: 'EXTENSION',
      dialNumber: '4093',
      answerEndpoint: {id: 'device-1', name: 'Webex App'},
    });

    expect(readRecoveryIntent()).toEqual({
      version: 2,
      loginOption: 'EXTENSION',
      dialNumber: '4093',
      answerEndpoint: {id: 'device-1', name: 'Webex App'},
    });
    const storedValue = window.sessionStorage.getItem(window.sessionStorage.key(0) || '');
    expect(storedValue).not.toContain('accessToken');

    clearRecoveryIntent();
    expect(readRecoveryIntent()).toBeUndefined();
  });
});

describe('recovered Contact Center session', () => {
  it('maps the SDK relogin profile to the existing agent state', () => {
    const session = recoveredAgentSession({
      isAgentLoggedIn: true,
      currentTeamId: 'team-1',
      deviceType: 'EXTENSION',
      dn: '4093',
      defaultDn: '4000',
      lastStateAuxCodeId: 'break',
      idleCodes: [{id: 'break', name: 'Break', isSystem: false}],
    } as Profile);

    expect(session).toMatchObject({
      loggedIn: true,
      lifecycle: 'idle',
      agentState: 'Break',
      teamId: 'team-1',
      dialNumber: '4093',
      deviceType: 'EXTENSION',
    });
  });

  it('does not treat the WebRTC agent identifier as a dial number', () => {
    const session = recoveredAgentSession({
      isAgentLoggedIn: true,
      currentTeamId: 'team-1',
      deviceType: 'BROWSER',
      dn: 'agent-1',
      lastStateAuxCodeId: '0',
      idleCodes: [],
    } as unknown as Profile);

    expect(session).toMatchObject({
      loggedIn: true,
      lifecycle: 'available',
      deviceType: 'BROWSER',
      dialNumber: '',
    });
  });
});
