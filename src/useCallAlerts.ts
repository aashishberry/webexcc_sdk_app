import {useCallback, useEffect, useRef, useState} from 'react';

interface CallAlertOptions {
  ringing: boolean;
  callKey: string;
  callerLabel: string;
  canAnswer: boolean;
  canDecline: boolean;
  onAnswer: () => void;
  onDecline: () => void;
}

type WebkitWindow = Window & typeof globalThis & {webkitAudioContext?: typeof AudioContext};

export function useCallAlerts({
  ringing,
  callKey,
  callerLabel,
  canAnswer,
  canDecline,
  onAnswer,
  onDecline,
}: CallAlertOptions) {
  const [enabled, setEnabled] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification === 'undefined' ? 'denied' : Notification.permission,
  );
  const audioContext = useRef<AudioContext>();
  const ringTimer = useRef<number>();
  const notificationSignature = useRef('');
  const answerRef = useRef(onAnswer);
  const declineRef = useRef(onDecline);

  useEffect(() => {
    answerRef.current = onAnswer;
    declineRef.current = onDecline;
  }, [onAnswer, onDecline]);

  const closeNotification = useCallback(async () => {
    if (!('serviceWorker' in navigator)) return;
    const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined);
    const notifications = await registration?.getNotifications({tag: 'wxcc-incoming'});
    notifications?.forEach((notification) => notification.close());
  }, []);

  const stopRinging = useCallback(() => {
    if (ringTimer.current) window.clearInterval(ringTimer.current);
    ringTimer.current = undefined;
  }, []);

  const ringPulse = useCallback(() => {
    const context = audioContext.current;
    if (!context || context.state !== 'running') return;
    const now = context.currentTime;
    for (const offset of [0, 0.32]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(440, now + offset);
      oscillator.frequency.linearRampToValueAtTime(520, now + offset + 0.16);
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.12, now + offset + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.24);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now + offset);
      oscillator.stop(now + offset + 0.25);
    }
  }, []);

  const showSystemNotification = useCallback(async () => {
    if (
      permission !== 'granted' ||
      !document.hidden ||
      !('serviceWorker' in navigator)
    ) return;
    const registration = await navigator.serviceWorker.ready;
    const options = {
      body: callerLabel ? `Incoming call from ${callerLabel}` : 'Incoming Contact Center call',
      tag: 'wxcc-incoming',
      renotify: true,
      requireInteraction: true,
      data: {callKey},
      actions: [
        ...(canAnswer ? [{action: 'answer', title: 'Answer'}] : []),
        ...(canDecline ? [{action: 'decline', title: 'Decline'}] : []),
      ],
    } as NotificationOptions;
    await registration.showNotification('Webex Contact Center', options);
  }, [callKey, callerLabel, canAnswer, canDecline, permission]);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    void navigator.serviceWorker.register('/call-alert-sw.js').catch(() => undefined);
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'webex-call-notification-action') return;
      if (event.data.callKey && event.data.callKey !== callKey) return;
      if (event.data.action === 'answer') answerRef.current();
      if (event.data.action === 'decline') declineRef.current();
    };
    navigator.serviceWorker.addEventListener('message', handleMessage);
    return () => navigator.serviceWorker.removeEventListener('message', handleMessage);
  }, [callKey]);

  useEffect(() => {
    if (!enabled || !ringing || !callKey) {
      stopRinging();
      if (!ringing) {
        notificationSignature.current = '';
        void closeNotification();
      }
      return;
    }
    const nextNotificationSignature = `${callKey}:${canAnswer}:${canDecline}:${callerLabel}`;
    if (notificationSignature.current !== nextNotificationSignature) {
      notificationSignature.current = nextNotificationSignature;
      void showSystemNotification();
    }
    if (!ringTimer.current) {
      ringPulse();
      ringTimer.current = window.setInterval(ringPulse, 1_700);
    }
    return stopRinging;
  }, [callKey, callerLabel, canAnswer, canDecline, closeNotification, enabled, ringPulse, ringing, showSystemNotification, stopRinging]);

  useEffect(() => {
    if (!enabled || !ringing) return;
    const handleVisibilityChange = () => {
      if (document.hidden) void showSystemNotification();
      else void closeNotification();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [closeNotification, enabled, ringing, showSystemNotification]);

  useEffect(() => () => stopRinging(), [stopRinging]);

  const toggle = useCallback(async () => {
    if (enabled) {
      setEnabled(false);
      stopRinging();
      notificationSignature.current = '';
      await closeNotification();
      return;
    }
    const AudioContextConstructor =
      window.AudioContext || (window as WebkitWindow).webkitAudioContext;
    if (AudioContextConstructor) {
      audioContext.current ??= new AudioContextConstructor();
      await audioContext.current.resume();
    }
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      const result = await Notification.requestPermission();
      setPermission(result);
    } else if (typeof Notification !== 'undefined') {
      setPermission(Notification.permission);
    }
    setEnabled(true);
  }, [closeNotification, enabled, stopRinging]);

  return {enabled, permission, toggle};
}
