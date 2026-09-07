// @vitest-environment jsdom

import {act, cleanup, renderHook} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {useCallAlerts} from './useCallAlerts';

const options = {
  ringing: false,
  callKey: '',
  callerLabel: '',
  canAnswer: false,
  canDecline: false,
  onAnswer: () => undefined,
  onDecline: () => undefined,
};

let notificationPermission: NotificationPermission;
const requestPermission = vi.fn(async () => {
  notificationPermission = 'granted';
  return notificationPermission;
});

beforeEach(() => {
  window.sessionStorage.clear();
  notificationPermission = 'default';
  requestPermission.mockClear();
  vi.stubGlobal('Notification', {
    get permission() {
      return notificationPermission;
    },
    requestPermission,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('call alert preference', () => {
  it('defaults alerts to enabled for a new browser-tab session', () => {
    const {result} = renderHook(() => useCallAlerts(options));

    expect(result.current.enabled).toBe(true);
  });

  it('retains an explicit opt-out across a refresh in the same tab', async () => {
    const first = renderHook(() => useCallAlerts(options));

    await act(() => first.result.current.toggle());
    expect(first.result.current.enabled).toBe(false);
    first.unmount();

    const refreshed = renderHook(() => useCallAlerts(options));
    expect(refreshed.result.current.enabled).toBe(false);
  });

  it('enables alerts and requests notification permission from the sign-in action', async () => {
    window.sessionStorage.setItem('webex-agent-console:call-alerts', 'disabled');
    const {result} = renderHook(() => useCallAlerts(options));

    await act(() => result.current.enable());

    expect(result.current.enabled).toBe(true);
    expect(result.current.permission).toBe('granted');
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem('webex-agent-console:call-alerts')).toBe('enabled');
  });
});
