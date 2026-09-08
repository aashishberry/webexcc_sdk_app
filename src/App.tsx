import {useEffect, useRef, useState} from 'react';
import {
  getOAuthStatus,
  getStationConfiguration,
  logoutOAuth,
  setPreferredAnswerEndpoint,
  type OAuthStatus,
  type StationConfigurationResponse,
} from './callingApi';
import {
  configuredExtensions,
  defaultEndpointId,
  endpointsForExtension,
  stationValue,
} from './stationConfiguration';
import {useController} from './useController';
import {SelectMenu, type SelectMenuOption} from './SelectMenu';
import {ControlIcon} from './ControlIcon';
import {useCallAlerts} from './useCallAlerts';
import {useTheme} from './useTheme';
import {InteractionInsights} from './InteractionInsights';
import {clearRecoveryIntent, readRecoveryIntent, saveRecoveryIntent} from './sessionRecovery';
import type {
  InitializeOptions,
  LifecycleStatus,
  StationLoginOption,
  StationLoginOptions,
} from './types';

const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatMetricDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  if (minutes < 60) return `${minutes}m ${String(remainder).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function sessionStatus(
  lifecycle: LifecycleStatus,
  agentState: string,
): {label: string; className: string} {
  if (lifecycle === 'signed-out') {
    return {label: 'Webex connected', className: 'presence-connected'};
  }
  if (lifecycle === 'initializing') {
    return {label: 'Initializing Contact Center', className: 'presence-progress'};
  }
  if (lifecycle === 'initialized') {
    return {label: 'CC ready · Station offline', className: 'presence-progress'};
  }
  return {label: agentState, className: `presence-${lifecycle}`};
}

export function App() {
  const {controller, snapshot} = useController();
  const theme = useTheme();
  const [busy, setBusy] = useState('');
  const [oauth, setOAuth] = useState<OAuthStatus>();
  const [oauthError, setOAuthError] = useState('');
  const [callingConfiguration, setCallingConfiguration] =
    useState<StationConfigurationResponse>();
  const [callingConfigurationError, setCallingConfigurationError] = useState('');
  const [answerEndpointId, setAnswerEndpointId] = useState('');
  const [rememberEndpoint, setRememberEndpoint] = useState(false);
  const [stationMode, setStationMode] = useState<StationLoginOption>('EXTENSION');
  const [extension, setExtension] = useState('');
  const [dialNumber, setDialNumber] = useState('');
  const [microphoneStatus, setMicrophoneStatus] = useState<
    'unchecked' | 'requesting' | 'ready' | 'denied'
  >('unchecked');
  const [microphoneName, setMicrophoneName] = useState('System default microphone');
  const [dialpadTaskId, setDialpadTaskId] = useState('');
  const [routeMode, setRouteMode] = useState<'consult' | 'transfer' | ''>('');
  const [routeTaskId, setRouteTaskId] = useState('');
  const [destinationId, setDestinationId] = useState('');
  const [summaryFocusRequest, setSummaryFocusRequest] = useState(0);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [clock, setClock] = useState(0);
  const [banner, setBanner] = useState<{kind: 'error'; message: string}>();
  const [form, setForm] = useState<InitializeOptions>({accessToken: ''});
  const recoveryAttempted = useRef(false);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void getOAuthStatus()
      .then((status) => {
        setOAuth(status);
        setForm((current) => ({...current, accessToken: status.accessToken}));
        if (new URLSearchParams(window.location.search).has('oauth')) {
          window.history.replaceState({}, '', window.location.pathname);
        }
      })
      .catch((error) => {
        console.error('[webex-agent-console] OAuth status request failed.');
        setOAuthError(error instanceof Error ? error.message : String(error));
      });
  }, []);

  useEffect(() => {
    if (!oauth?.authenticated) return;
    let cancelled = false;
    void getStationConfiguration()
      .then((configuration) => {
        if (cancelled) return;
        setCallingConfiguration(configuration);
        const extensions = configuredExtensions(configuration);
        const primary = extensions.find((candidate) => candidate.type === 'PRIMARY') ?? extensions[0];
        const value = primary ? stationValue(primary) : '';
        if (value) setExtension((current) => current || value);
        setAnswerEndpointId((current) => current || defaultEndpointId(configuration, primary));
      })
      .catch((error) => {
        if (!cancelled) {
          console.error('[webex-agent-console] Station configuration request failed.');
          setCallingConfigurationError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [oauth?.authenticated]);

  useEffect(() => {
    const audio = remoteAudioRef.current;
    if (!audio) return;
    audio.srcObject = snapshot.remoteAudioTrack
      ? new MediaStream([snapshot.remoteAudioTrack])
      : null;
    if (snapshot.remoteAudioTrack) {
      void audio.play().catch(() => {
        console.error('[webex-agent-console] Browser call audio playback was blocked.');
        setBanner({
          kind: 'error',
          message: 'Caller audio was blocked by the browser. Allow audio playback for this site and retry.',
        });
      });
    }
    return () => {
      audio.srcObject = null;
    };
  }, [snapshot.remoteAudioTrack]);

  useEffect(() => {
    if (!oauth?.authenticated || recoveryAttempted.current) return;
    recoveryAttempted.current = true;
    const intent = readRecoveryIntent();
    if (!intent) {
      return;
    }

    const recover = async () => {
      await Promise.resolve();
      setStationMode(intent.loginOption);
      if (intent.loginOption === 'EXTENSION') {
        setExtension(intent.dialNumber);
      } else if (intent.loginOption === 'AGENT_DN') {
        setDialNumber(intent.dialNumber);
      }
      setAnswerEndpointId(intent.answerEndpoint?.id || '');
      setBusy('recovery');
      setBanner(undefined);
      try {
        await controller.initialize({accessToken: oauth.accessToken});
        const recoveredSnapshot = controller.getSnapshot();
        const recoveredMode = recoveredSnapshot.stationLoginOption ||
          (recoveredSnapshot.loginVoiceOptions.includes(intent.loginOption)
            ? intent.loginOption
            : recoveredSnapshot.loginVoiceOptions[0] || 'EXTENSION');
        const recoveredDialNumber = recoveredSnapshot.stationDialNumber || intent.dialNumber;
        setStationMode(recoveredMode);
        if (recoveredMode === 'EXTENSION') setExtension(recoveredDialNumber);
        if (recoveredMode === 'AGENT_DN') setDialNumber(recoveredDialNumber);
        saveRecoveryIntent({
          loginOption: recoveredMode,
          dialNumber: recoveredMode === 'BROWSER' ? '' : recoveredDialNumber,
          answerEndpoint: recoveredMode === 'EXTENSION' ? intent.answerEndpoint : undefined,
        });
      } catch (error) {
        console.error('[webex-agent-console] Contact Center session recovery failed.');
        setBanner({
          kind: 'error',
          message: `The previous session could not be restored. Check the station settings and initialize again. ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      } finally {
        setBusy('');
      }
    };
    void recover();
  }, [controller, oauth?.accessToken, oauth?.authenticated]);

  const run = async (name: string, action: () => void | Promise<void>) => {
    setBusy(name);
    setBanner(undefined);
    try {
      await action();
    } catch (error) {
      setBanner({kind: 'error', message: error instanceof Error ? error.message : String(error)});
    } finally {
      setBusy('');
    }
  };

  const canAnswer = snapshot.callStatus === 'ringing' && snapshot.acceptCapable;
  const canDecline = snapshot.callStatus === 'ringing' && snapshot.declineCapable;
  const callAlerts = useCallAlerts({
    ringing: snapshot.callStatus === 'ringing',
    callKey: snapshot.interactionId,
    callerLabel: snapshot.callerNumber || snapshot.callerName,
    canAnswer,
    canDecline,
    onAnswer: () => void run('answer', () => controller.answer()),
    onDecline: () => void run('decline', () => controller.decline()),
  });

  const initialized = ['initialized', 'station-logged-in', 'available', 'idle'].includes(
    snapshot.lifecycle,
  );
  const stationLoggedIn = ['station-logged-in', 'available', 'idle'].includes(snapshot.lifecycle);
  const activeInteraction =
    Boolean(snapshot.activeTask) ||
    ['ringing', 'answering', 'rona', 'connected', 'held', 'wrap-up'].includes(snapshot.callStatus);
  const hasCall = snapshot.callStatus !== 'none';
  const wrapupActive = snapshot.callStatus === 'wrap-up';
  const consultConnecting = snapshot.consultStatus === 'connecting';
  const consultInitiatedByAgent =
    snapshot.consultActive && snapshot.activeTask?.data?.isConsulted !== true;
  const stateChangeDisabled =
    busy !== '' || ['ringing', 'answering'].includes(snapshot.callStatus);
  const queuedIdleState = snapshot.agentState !== 'Available'
    ? snapshot.idleCodes.find((code) => code.id === snapshot.selectedIdleCode)?.name || snapshot.agentState
    : '';
  const withQueuedState = (label: string) =>
    queuedIdleState ? `${label} · ${queuedIdleState} next` : label;
  const interactionPresence = ['ringing', 'answering'].includes(snapshot.callStatus)
    ? {value: 'interaction:reserved', label: withQueuedState('Reserved'), className: 'is-reserved'}
    : snapshot.callStatus === 'rona'
      ? {value: 'interaction:rona', label: 'RONA', className: 'is-rona'}
    : snapshot.callStatus === 'wrap-up'
      ? {value: 'interaction:wrap-up', label: withQueuedState('Pending wrap-up'), className: 'is-wrapup'}
      : ['connected', 'held'].includes(snapshot.callStatus)
        ? {value: 'interaction:engaged', label: withQueuedState('Engaged'), className: 'is-engaged'}
        : undefined;
  const selectedTeam = snapshot.teams.find((team) => team.id === snapshot.selectedTeamId);
  const headerStatus = sessionStatus(snapshot.lifecycle, snapshot.agentState);
  const extensionOptions = configuredExtensions(callingConfiguration);
  const selectedExtension = extensionOptions.find(
    (candidate) => stationValue(candidate) === extension,
  );
  const answerEndpointOptions = endpointsForExtension(callingConfiguration, selectedExtension);
  const selectedEndpoint = answerEndpointOptions.find(
    (endpoint) => endpoint.id === answerEndpointId,
  );
  const endpointAlreadyPreferred = Boolean(
    selectedEndpoint && selectedEndpoint.id === callingConfiguration?.preferred?.id,
  );
  const selectableIdleCodes = snapshot.idleCodes.filter((code) => !code.isSystem);
  const dialpadOpen = Boolean(
    snapshot.interactionId && dialpadTaskId === snapshot.interactionId,
  );
  const activeRouteMode = routeTaskId === snapshot.interactionId ? routeMode : '';
  const extensionMenuOptions: SelectMenuOption[] = extensionOptions.map((extension) => {
    const value = stationValue(extension);
    return {
      value,
      label: `${value}${extension.type === 'PRIMARY' ? ' · Primary' : ''}`,
    };
  });
  const endpointMenuOptions: SelectMenuOption[] = answerEndpointOptions.map((endpoint) => ({
    value: endpoint.id,
    label: `${endpoint.name || endpoint.type || 'Webex endpoint'}${
      endpoint.status === 'CONNECTED'
        ? ' · Registered'
        : endpoint.status === 'NOT_CONNECTED'
          ? ' · Not registered'
          : ''
    }`,
    disabled: endpoint.status === 'NOT_CONNECTED',
  }));
  const teamMenuOptions: SelectMenuOption[] = snapshot.teams.map((team) => ({
    value: team.id,
    label: team.name,
  }));
  const stateMenuOptions: SelectMenuOption[] = [
    ...(interactionPresence
      ? [{
          value: interactionPresence.value,
          label: interactionPresence.label,
          disabled: true,
          group: 'Current interaction',
        }]
      : []),
    {value: 'available', label: 'Available'},
    ...(selectableIdleCodes.length === 0 ? [{value: 'idle', label: 'Idle'}] : []),
    ...selectableIdleCodes.map((code) => ({
      value: `idle:${code.id}`,
      label: code.name,
      group: 'Idle reasons',
    })),
  ];
  const wrapupMenuOptions: SelectMenuOption[] = snapshot.wrapupCodes.map((code) => ({
    value: code.id,
    label: code.name,
  }));
  const destinationMenuOptions: SelectMenuOption[] = snapshot.destinations.map((destination) => ({
    value: destination.id,
    label: `${destination.name}${destination.detail ? ` · ${destination.detail}` : ''}`,
    group: destination.type === 'agent' ? 'Agents' : 'Queues',
  }));
  const selectedAnswerEndpoint = selectedEndpoint
    ? {
        id: selectedEndpoint.id,
        name: selectedEndpoint.name || 'Selected Webex endpoint',
        type: selectedEndpoint.type,
        status: selectedEndpoint.status,
      }
    : undefined;
  const stationDialNumber = stationMode === 'EXTENSION' ? extension : dialNumber;
  const stationConnectionLabel =
    snapshot.stationLoginOption === 'BROWSER'
      ? 'Browser audio'
      : snapshot.stationLoginOption === 'AGENT_DN'
        ? `Dial number ${snapshot.stationDialNumber}`
        : snapshot.stationLoginOption === 'EXTENSION'
          ? `Webex App · ${snapshot.stationDialNumber}`
          : 'Station not connected';
  const stationModes: Array<{
    id: StationLoginOption;
    title: string;
    description: string;
    icon: 'webex' | 'desktop' | 'dial';
  }> = [
    {
      id: 'EXTENSION',
      title: 'Webex App',
      description: 'Answer on a registered Webex Calling device.',
      icon: 'webex',
    },
    {
      id: 'BROWSER',
      title: 'This browser',
      description: 'Use WebRTC with this device’s microphone and speakers.',
      icon: 'desktop',
    },
    {
      id: 'AGENT_DN',
      title: 'Dial number',
      description: 'Send Contact Center calls to another phone number.',
      icon: 'dial',
    },
  ];
  const stationTargetValid = stationMode === 'BROWSER' || Boolean(stationDialNumber.trim());
  const endpointSelectionValid =
    stationMode !== 'EXTENSION' ||
    answerEndpointOptions.length === 0 ||
    Boolean(selectedEndpoint);
  const topbarSubtitle = !initialized
    ? 'A focused workspace for customer calls'
    : `${stationLoggedIn ? stationConnectionLabel : 'Contact Center ready'}${
        stationLoggedIn && selectedTeam ? ` · ${selectedTeam.name}` : ''
      }`;
  const routingStateValue = snapshot.agentState === 'Available'
    ? 'available'
    : snapshot.selectedIdleCode
      ? `idle:${snapshot.selectedIdleCode}`
      : 'idle';
  const stateValue = interactionPresence?.value ?? routingStateValue;
  const displayedStateStartedAt = snapshot.callStatus === 'wrap-up'
    ? snapshot.wrapupStartedAt
    : snapshot.callStatus === 'rona'
      ? snapshot.stateChangedAt
    : interactionPresence
      ? snapshot.callStartedAt
      : snapshot.stateChangedAt;
  const stateElapsed = clock && displayedStateStartedAt
    ? formatElapsed(clock - displayedStateStartedAt)
    : '0:00';
  const callElapsed = clock && snapshot.callStartedAt
    ? formatElapsed((snapshot.callEndedAt || clock) - snapshot.callStartedAt)
    : '0:00';
  const wrapupElapsed = clock && snapshot.wrapupStartedAt
    ? formatElapsed(clock - snapshot.wrapupStartedAt)
    : '0:00';
  const displayParticipants = snapshot.participants.length
    ? snapshot.participants
    : [
        {id: 'agent', name: snapshot.agentName || 'You', type: 'Agent', state: 'Connected', held: false, isCurrentAgent: true},
        {id: 'customer', name: snapshot.callerName || 'Customer', type: 'Customer', state: snapshot.held ? 'Held' : 'Connected', held: snapshot.held, isCurrentAgent: false},
        ...(snapshot.consultDestinationName
          ? [{
              id: 'consult',
              name: snapshot.consultDestinationName,
              type: snapshot.consultDestinationType === 'queue' ? 'Queue' : 'Agent',
              state: consultConnecting ? 'Connecting' : 'Connected',
              held: false,
              isCurrentAgent: false,
            }]
          : []),
      ];
  const activeParticipantCount = displayParticipants.filter(
    (participant) => participant.state !== 'Disconnected',
  ).length;
  const customerDisconnected = snapshot.conferenceActive && (
    snapshot.customerLeft || displayParticipants.some(
      (participant) => participant.type === 'Customer' && participant.state === 'Disconnected',
    )
  );

  const selectExtension = (extension: string) => {
    const configuration = callingConfiguration;
    const selected = extensionOptions.find((candidate) => stationValue(candidate) === extension);
    setExtension(extension);
    setAnswerEndpointId(defaultEndpointId(configuration, selected));
    setRememberEndpoint(false);
  };

  const initialize = async () => {
    if (callAlerts.enabled) await callAlerts.prepare();
    await controller.initialize(form);
    const registered = controller.getSnapshot();
    const selectedMode = registered.loginVoiceOptions.includes(stationMode)
      ? stationMode
      : registered.loginVoiceOptions[0] || 'EXTENSION';
    setStationMode(selectedMode);
    saveRecoveryIntent({
      loginOption: selectedMode,
      dialNumber: selectedMode === 'EXTENSION' ? extension : selectedMode === 'AGENT_DN' ? dialNumber : '',
      answerEndpoint: selectedMode === 'EXTENSION' ? selectedAnswerEndpoint : undefined,
    });
  };

  const prepareBrowserAudio = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicrophoneStatus('denied');
      throw new Error('This browser does not expose microphone access. Use HTTPS or choose another station mode.');
    }
    setMicrophoneStatus('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio: true});
      const track = stream.getAudioTracks()[0];
      setMicrophoneName(track?.label || 'System default microphone');
      for (const mediaTrack of stream.getTracks()) mediaTrack.stop();
      setMicrophoneStatus('ready');
    } catch (error) {
      setMicrophoneStatus('denied');
      throw new Error(
        `Microphone access is required for browser calling. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  const stationLogin = async () => {
    if (callAlerts.enabled) await callAlerts.prepare();
    if (stationMode === 'BROWSER' && microphoneStatus !== 'ready') {
      await prepareBrowserAudio();
    }
    if (stationMode === 'EXTENSION' && rememberEndpoint && selectedEndpoint) {
      await setPreferredAnswerEndpoint(selectedEndpoint.id);
      setCallingConfiguration((current) =>
        current ? {...current, preferred: selectedEndpoint} : current,
      );
      setRememberEndpoint(false);
    }
    const options: StationLoginOptions = {
      loginOption: stationMode,
      ...(stationMode === 'BROWSER' ? {} : {dialNumber: stationDialNumber}),
      ...(stationMode === 'EXTENSION' && selectedAnswerEndpoint
        ? {answerEndpoint: selectedAnswerEndpoint}
        : {}),
    };
    await controller.stationLogin(options);
    saveRecoveryIntent(options);
  };

  const openRoutePanel = async (mode: 'consult' | 'transfer') => {
    setRouteMode(mode);
    setRouteTaskId(snapshot.interactionId);
    setDestinationId('');
    setSummaryFocusRequest((request) => request + 1);
    if (
      !snapshot.midCallSummary &&
      !['requesting', 'accepted', 'received'].includes(snapshot.aiSummaryStatus)
    ) {
      void controller.requestSummary('mid-call').catch(() => undefined);
    }
    if (!snapshot.destinationsLoaded) {
      await run('destinations', () => controller.loadDestinations());
    }
  };

  const logout = async () => {
    if (snapshot.lifecycle !== 'signed-out') await controller.logout();
    await logoutOAuth();
    clearRecoveryIntent();
    setOAuth((current) =>
      current
        ? {
            ...current,
            authenticated: false,
            accessToken: '',
            profile: {displayName: ''},
          }
        : current,
    );
    setCallingConfiguration(undefined);
    setCallingConfigurationError('');
    setAnswerEndpointId('');
    setRememberEndpoint(false);
    setStationMode('EXTENSION');
    setDialNumber('');
    setMicrophoneStatus('unchecked');
    setMicrophoneName('System default microphone');
    setDialpadTaskId('');
    setRouteMode('');
    setRouteTaskId('');
    setDestinationId('');
    setParticipantsOpen(false);
    setForm({accessToken: ''});
    setExtension('');
  };

  if (!oauth) {
    return (
      <main className="auth-page">
        <section className="auth-card">
          <div className="brand-mark">W</div>
          <h1>Webex Agent Console</h1>
          <p>{oauthError || 'Checking the OAuth session…'}</p>
        </section>
      </main>
    );
  }

  if (!oauth.authenticated) {
    return (
      <main className="auth-page">
        <section className="auth-card">
          <div className="brand-mark">W</div>
          <p className="eyebrow">Webex Contact Center</p>
          <h1>Agent Console</h1>
          <p>
            Sign in with Webex to load your Contact Center profile, teams, and voice options.
          </p>
          {!oauth.configured && (
            <div className="notice error-notice">
              Configure WEBEX_CLIENT_ID and WEBEX_CLIENT_SECRET in the server environment first.
            </div>
          )}
          <button
            className="button primary oauth-button"
            disabled={!oauth.configured}
            onClick={() => void callAlerts.enable().finally(() => {
              window.location.assign('/api/oauth/login');
            })}
          >
            Continue with Webex
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <audio ref={remoteAudioRef} className="remote-audio" autoPlay aria-hidden="true" />
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark small">W</span>
          <div>
            <strong>
              {oauth.profile.displayName
                ? `${oauth.profile.displayName}’s Console`
                : 'Webex Agent Console'}
            </strong>
            <span>{topbarSubtitle}</span>
          </div>
        </div>
        <div className="session-actions">
          {stationLoggedIn ? (
            <div className={`state-pill ${interactionPresence?.className ?? (snapshot.agentState === 'Available' ? 'is-available' : 'is-idle')}`}>
              <span className="state-dot" aria-hidden="true" />
              <SelectMenu
                ariaLabel="Agent state"
                className="state-pill-select"
                disabled={stateChangeDisabled}
                value={stateValue}
                options={stateMenuOptions}
                onChange={(value) => {
                  void run('agent-state', () =>
                    value === 'available'
                      ? controller.setAvailable()
                      : controller.setIdle(value.replace(/^idle:/, '')),
                  );
                }}
              />
              <time title="Time in current state">{stateElapsed}</time>
            </div>
          ) : (
            <span className={`agent-presence ${headerStatus.className}`}>{headerStatus.label}</span>
          )}
          <button
            type="button"
            className={`topbar-tool ${callAlerts.enabled ? 'is-active' : ''}`}
            aria-pressed={callAlerts.enabled}
            title={
              callAlerts.enabled
                ? `Call alerts enabled${
                    callAlerts.permission === 'denied'
                      ? ' · system notifications blocked'
                      : callAlerts.permission === 'default'
                        ? ' · notification permission will be requested'
                        : ''
                  }`
                : 'Enable call alerts'
            }
            disabled={busy !== ''}
            onClick={() => void run('alerts', callAlerts.toggle)}
          >
            <ControlIcon name="bell" />
            <span>Alerts</span>
          </button>
          <button
            type="button"
            className={`topbar-tool ${theme.mode === 'system' ? 'is-active' : ''}`}
            title={`Theme: ${theme.mode}. Change theme`}
            onClick={theme.cycle}
          >
            <ControlIcon name="theme" />
            <span>{theme.mode === 'system' ? 'Auto' : theme.mode}</span>
          </button>
          <button
            type="button"
            className={`topbar-tool ${diagnosticsOpen ? 'is-active' : ''}`}
            aria-pressed={diagnosticsOpen}
            title="Runtime diagnostics"
            onClick={() => setDiagnosticsOpen((open) => !open)}
          >
            <ControlIcon name="activity" />
            <span>Diag</span>
          </button>
          <button
            className="button logout-button"
            disabled={activeInteraction || busy !== ''}
            onClick={() => run('logout', logout)}
          >
            {busy === 'logout' ? 'Logging out…' : 'Logout'}
          </button>
        </div>
      </header>

      {banner && (
        <div className={`app-banner banner-${banner.kind}`} role="alert">
          <span className="banner-icon" aria-hidden="true">!</span>
          <span>{banner.message}</span>
          <button type="button" aria-label="Dismiss message" onClick={() => setBanner(undefined)}>×</button>
        </div>
      )}

      <div className={`console-layout ${stationLoggedIn && activeInteraction ? 'has-insights' : ''}`}>
        <section className={`panel flow-panel ${stationLoggedIn && activeInteraction ? 'interaction-sidebar' : ''}`}>
          {!stationLoggedIn ? (
            <>
              <div className="panel-heading">
                <div>
                  <p className="section-kicker">{initialized ? 'Voice connection' : 'Contact Center'}</p>
                  <h2>{initialized ? 'Where should calls ring?' : 'Connect your agent workspace'}</h2>
                </div>
                <span className={initialized ? 'pending-chip' : 'neutral-chip'}>
                  {initialized ? 'Station offline' : 'OAuth connected'}
                </span>
              </div>

              {!initialized ? (
                <div className="connect-workspace">
                  <div className="connection-summary">
                    <span className="connection-illustration"><ControlIcon name="headset" /></span>
                    <div>
                      <strong>Webex authorization is ready</strong>
                      <span>
                        Initialize the Contact Center SDK to load your teams, voice options,
                        agent states, and task controls.
                      </span>
                    </div>
                  </div>
                  <div className="connect-actions">
                    <span>Station preferences are selected after your agent profile loads.</span>
                    <button
                      className="button primary initialize-button"
                      disabled={busy !== ''}
                      onClick={() => run('initialize', initialize)}
                    >
                      {busy === 'recovery'
                        ? 'Restoring workspace…'
                        : busy === 'initialize'
                          ? 'Connecting…'
                          : 'Connect Contact Center'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="station-login-composer">
                  <div className="station-mode-grid" role="radiogroup" aria-label="Voice connection">
                    {stationModes.map((mode) => {
                      const available =
                        snapshot.loginVoiceOptions.includes(mode.id) &&
                        (mode.id !== 'BROWSER' || snapshot.webRtcEnabled);
                      return (
                        <label
                          key={mode.id}
                          className={`station-mode-card ${stationMode === mode.id ? 'is-selected' : ''} ${!available ? 'is-disabled' : ''}`}
                        >
                          <input
                            type="radio"
                            name="station-mode"
                            value={mode.id}
                            checked={stationMode === mode.id}
                            disabled={!available || busy !== ''}
                            onChange={() => setStationMode(mode.id)}
                          />
                          <span className="station-mode-icon"><ControlIcon name={mode.icon} /></span>
                          <span className="station-mode-copy">
                            <strong>{mode.title}</strong>
                            <small>{available ? mode.description : 'Not enabled for this agent profile.'}</small>
                          </span>
                          <span className="station-mode-radio" aria-hidden="true" />
                        </label>
                      );
                    })}
                  </div>

                  <div className="station-details-card">
                    <label>
                      Agent team
                      <SelectMenu
                        ariaLabel="Agent team"
                        value={snapshot.selectedTeamId}
                        options={teamMenuOptions}
                        onChange={(value) => controller.selectTeam(value)}
                      />
                    </label>

                    {stationMode === 'EXTENSION' && (
                      <>
                        <div className="station-selection-grid">
                          <label>
                            Calling extension
                            {extensionOptions.length > 0 ? (
                              <SelectMenu
                                ariaLabel="Calling extension"
                                value={extension}
                                options={extensionMenuOptions}
                                placeholder="Select a Calling extension"
                                onChange={selectExtension}
                              />
                            ) : (
                              <input
                                inputMode="tel"
                                autoComplete="tel"
                                placeholder="Enter your Calling extension"
                                value={extension}
                                onChange={(event) => selectExtension(event.target.value)}
                              />
                            )}
                          </label>
                          <label>
                            Answer device
                            <SelectMenu
                              ariaLabel="Answer device"
                              value={answerEndpointId}
                              disabled={answerEndpointOptions.length === 0}
                              options={endpointMenuOptions}
                              placeholder={answerEndpointOptions.length ? 'Select an answer device' : 'Webex default device'}
                              onChange={(value) => {
                                setAnswerEndpointId(value);
                                setRememberEndpoint(false);
                              }}
                            />
                          </label>
                        </div>
                        {selectedEndpoint && (
                          <label className={`remember-endpoint ${endpointAlreadyPreferred ? 'current-preference' : ''}`}>
                            <input
                              type="checkbox"
                              checked={endpointAlreadyPreferred || rememberEndpoint}
                              disabled={endpointAlreadyPreferred}
                              onChange={(event) => setRememberEndpoint(event.target.checked)}
                            />
                            {endpointAlreadyPreferred
                              ? 'Current preferred Webex Calling answer device'
                              : 'Use as my preferred Webex Calling answer device'}
                          </label>
                        )}
                        {callingConfigurationError && (
                          <div className="notice warning-notice compact-notice">
                            Calling configuration is unavailable. You can enter an extension manually;
                            Webex will use its configured device routing.
                          </div>
                        )}
                      </>
                    )}

                    {stationMode === 'BROWSER' && (
                      <div className={`browser-audio-status microphone-${microphoneStatus}`}>
                        <span className="browser-audio-icon"><ControlIcon name="mic" /></span>
                        <div>
                          <strong>{microphoneStatus === 'ready' ? microphoneName : 'Browser audio'}</strong>
                          <span>
                            {microphoneStatus === 'ready'
                              ? 'Microphone access is ready. Caller audio will play in this tab.'
                              : microphoneStatus === 'denied'
                                ? 'Microphone access is blocked. Allow it in browser site settings and retry.'
                                : 'Microphone permission will be requested when you sign in to the station.'}
                          </span>
                        </div>
                        {microphoneStatus !== 'ready' && (
                          <button
                            type="button"
                            className="button secondary audio-check-button"
                            disabled={busy !== '' || microphoneStatus === 'requesting'}
                            onClick={() => run('microphone', prepareBrowserAudio)}
                          >
                            {microphoneStatus === 'requesting' ? 'Checking…' : 'Check audio'}
                          </button>
                        )}
                      </div>
                    )}

                    {stationMode === 'AGENT_DN' && (
                      <label>
                        Dial number
                        <input
                          inputMode="tel"
                          autoComplete="tel"
                          placeholder="Enter a valid number, preferably E.164"
                          value={dialNumber}
                          onChange={(event) => setDialNumber(event.target.value)}
                        />
                        <small className="field-help">The SDK validates this number against the dial plan assigned to your profile.</small>
                      </label>
                    )}

                    <div className="station-login-footer">
                      <span>
                        {stationMode === 'BROWSER'
                          ? 'Calls and media stay in this browser tab.'
                          : stationMode === 'AGENT_DN'
                            ? 'Incoming calls will ring the number above.'
                            : 'Incoming calls will ring in Webex App.'}
                      </span>
                      <button
                        className="button primary station-login-button"
                        disabled={
                          busy !== '' ||
                          !snapshot.selectedTeamId ||
                          !stationTargetValid ||
                          !endpointSelectionValid
                        }
                        onClick={() => run('station-login', stationLogin)}
                      >
                        {busy === 'station-login' ? 'Connecting station…' : 'Use this connection'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className={`panel-heading workspace-heading ${activeInteraction ? 'interaction-heading' : ''}`}>
                <div>
                  <p className="section-kicker">{selectedTeam?.name || 'Agent workspace'}</p>
                  <h2>
                    {wrapupActive
                      ? 'Wrap up interaction'
                      : snapshot.callStatus === 'rona'
                        ? 'Missed interaction'
                      : snapshot.conferenceActive
                        ? 'Conference call'
                        : snapshot.consultActive
                          ? 'Consultation'
                          : hasCall
                            ? 'Active interaction'
                            : 'Agent controls'}
                  </h2>
                </div>
                {activeInteraction ? (
                  wrapupActive ? (
                    <div className="interaction-timers" aria-label="Interaction timing">
                      <div className="interaction-timer call-duration-timer">
                        <time>{callElapsed}</time>
                        <span>Call duration</span>
                      </div>
                      <div className="interaction-timer wrapup-timer">
                        <time>{wrapupElapsed}</time>
                        <span>Wrap-up</span>
                      </div>
                    </div>
                  ) : snapshot.callStatus === 'rona' ? (
                    <div className="interaction-timer">
                      <time>{callElapsed}</time>
                      <span>Offer duration</span>
                    </div>
                  ) : (
                    <div className="interaction-timer">
                      <time>{callElapsed}</time>
                      <span>{snapshot.callStatus}</span>
                    </div>
                  )
                ) : (
                  <span className="station-health"><i />{snapshot.lineStatus}</span>
                )}
              </div>

              {!hasCall ? (
                <div className="ready-workspace">
                  <div className="ready-state">
                    <div className="status-orb" aria-hidden="true"><span /></div>
                    <div>
                      <strong>{snapshot.agentState === 'Available' ? 'Ready for an incoming task' : 'Agent is idle'}</strong>
                      <span>
                        {snapshot.agentState === 'Available'
                          ? 'Contact Center is listening for interactions. Task controls remain idle until a call arrives.'
                          : 'Change the agent state to Available when you are ready to receive calls.'}
                      </span>
                    </div>
                  </div>

                  <section className="performance-section" aria-labelledby="performance-title">
                    <div className="performance-heading">
                      <div>
                        <p className="section-kicker">My performance</p>
                        <h3 id="performance-title">Today</h3>
                      </div>
                      <button
                        type="button"
                        className="performance-refresh"
                        disabled={snapshot.performanceStatus === 'loading'}
                        onClick={() => void controller.loadPerformance()}
                      >
                        {snapshot.performanceStatus === 'loading' ? 'Refreshing…' : 'Refresh'}
                      </button>
                    </div>

                    {snapshot.performanceStatus === 'loading' ? (
                      <div className="performance-grid" aria-label="Loading performance statistics">
                        {[0, 1, 2, 3].map((item) => <span key={item} className="metric-skeleton" />)}
                      </div>
                    ) : snapshot.performanceStatus === 'ready' && snapshot.performance ? (
                      <div className="performance-grid">
                        <article className="performance-card">
                          <span>Completed</span>
                          <strong>{snapshot.performance.handled}</strong>
                          <small>interactions</small>
                        </article>
                        <article className="performance-card">
                          <span>Avg talk</span>
                          <strong>{formatMetricDuration(snapshot.performance.averageConnectedSeconds)}</strong>
                          <small>connected time</small>
                        </article>
                        <article className="performance-card">
                          <span>Avg hold</span>
                          <strong>{formatMetricDuration(snapshot.performance.averageHoldSeconds)}</strong>
                          <small>per interaction</small>
                        </article>
                        <article className="performance-card">
                          <span>Avg wrap-up</span>
                          <strong>{formatMetricDuration(snapshot.performance.averageWrapupSeconds)}</strong>
                          <small>per interaction</small>
                        </article>
                      </div>
                    ) : (
                      <div className="performance-unavailable">
                        <strong>Reporting unavailable</strong>
                        <span>{snapshot.performanceMessage || 'Connect Contact Center to load today’s statistics.'}</span>
                      </div>
                    )}
                    <p className="performance-caption">
                      Completed telephony interactions where you were the last handling agent. Times use your local day.
                    </p>
                  </section>
                </div>
              ) : (
                <>
                  <div className={`call-card call-${snapshot.callStatus} ${customerDisconnected ? 'customer-disconnected' : ''}`}>
                    <div className="avatar">{snapshot.callerName.charAt(0) || 'W'}</div>
                    <div className="caller-copy">
                      <span className="call-state">
                        {customerDisconnected
                          ? 'Customer left'
                          : snapshot.conferenceActive
                            ? 'Conference'
                          : snapshot.consultActive
                            ? 'Consultation'
                            : snapshot.callStatus}
                      </span>
                      <strong>{snapshot.callerName || 'Contact Center caller'}</strong>
                      <span>{snapshot.callerNumber || 'Number unavailable'}</span>
                    </div>
                    {snapshot.recordingActive && (
                      <div className="call-badges">
                        <span className={`recording-badge ${snapshot.recordingPaused ? 'is-paused' : ''}`}>
                          <i aria-hidden="true" />
                          {snapshot.recordingPaused ? 'Recording paused' : 'Recording'}
                        </span>
                      </div>
                    )}
                  </div>

                  {[
                    snapshot.interactionContext.queueName,
                    snapshot.interactionContext.reason,
                    snapshot.interactionContext.language,
                    snapshot.interactionContext.ivrPath,
                    snapshot.interactionContext.entryPoint,
                  ].some(Boolean) || snapshot.queueDurationMs > 0 ? (
                    <div className="context-chips" aria-label="Interaction context">
                      {snapshot.interactionContext.queueName && <span>Queue · {snapshot.interactionContext.queueName}</span>}
                      {snapshot.queueDurationMs > 0 && <span>Queued · {formatElapsed(snapshot.queueDurationMs)}</span>}
                      {snapshot.interactionContext.reason && <span>Reason · {snapshot.interactionContext.reason}</span>}
                      {snapshot.interactionContext.language && <span>Language · {snapshot.interactionContext.language}</span>}
                      {snapshot.interactionContext.ivrPath && <span>IVR · {snapshot.interactionContext.ivrPath}</span>}
                      {snapshot.interactionContext.entryPoint && <span>Entry · {snapshot.interactionContext.entryPoint}</span>}
                    </div>
                  ) : null}

                  <details className="call-metadata">
                    <summary>Interaction details</summary>
                    <div className="id-grid">
                      <div><span>WxCC interactionId</span><code title={snapshot.interactionId}>{snapshot.interactionId || '—'}</code></div>
                    </div>
                  </details>

                  {wrapupActive ? null : snapshot.callStatus === 'rona' ? (
                    <div className="notice rona-notice">
                      The call was redirected after it was not answered. Select your next agent state when ready.
                    </div>
                  ) : snapshot.callStatus === 'ended' ? (
                    <div className="notice pending-notice">
                      Calling media has ended. Waiting for Contact Center to confirm whether wrap-up is required.
                    </div>
                  ) : (
                    <>
                      {snapshot.callStatus === 'ringing' && !canAnswer && (
                        <div className="notice pending-notice station-answer-hint">
                          Answer this interaction on {stationConnectionLabel.toLowerCase()}.
                        </div>
                      )}

                      {snapshot.consultActive && (
                        <div className="consult-session">
                          <div className="consult-heading">
                            <div>
                              <span className="section-kicker">Consultation</span>
                              <strong>{consultConnecting ? 'Waiting for destination to answer' : 'Private conversation connected'}</strong>
                            </div>
                            <span className={`live-chip ${consultConnecting ? 'is-pending' : ''}`}>
                              <i />{consultConnecting ? 'Connecting' : 'Connected'}
                            </span>
                          </div>
                          <div className="participant-list">
                            <div className="participant-row">
                              <span className="participant-avatar">{snapshot.callerName.charAt(0) || 'C'}</span>
                              <div><strong>{snapshot.callerName || 'Customer'}</strong><span>{snapshot.callerNumber || 'Contact Center caller'} · On hold</span></div>
                              <span className="held-chip">Held</span>
                            </div>
                            <div className="participant-row">
                              <span className="participant-avatar">{snapshot.consultDestinationName.charAt(0) || 'A'}</span>
                              <div>
                                <strong>{snapshot.consultDestinationName || 'Consult destination'}</strong>
                                <span>
                                  {snapshot.consultDestinationType === 'queue' ? 'Consult queue' : 'Consult agent'} · {consultConnecting ? 'Waiting' : 'Connected'}
                                </span>
                              </div>
                              {consultInitiatedByAgent ? (
                                <button
                                  type="button"
                                  className="drop-participant consult-drop-button"
                                  disabled={busy !== '' || (!consultConnecting && !snapshot.endConsultCapable)}
                                  onClick={() => run(consultConnecting ? 'cancel-consult' : 'end-consult', () => controller.endConsult())}
                                >
                                  <ControlIcon name="phone" /> {consultConnecting ? 'Cancel' : 'Drop'}
                                </button>
                              ) : (
                                <span className={consultConnecting ? 'pending-chip' : 'connected-chip'}>
                                  {consultConnecting ? 'Waiting' : 'Connected'}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      )}

                      {snapshot.conferenceActive && (
                        <div className="conference-session">
                          <div className="consult-heading">
                            <div><span className="section-kicker">Conference</span><strong>{customerDisconnected ? 'Customer has left the call' : 'Everyone is connected'}</strong></div>
                            <span className="live-chip"><i />{activeParticipantCount} active participants</span>
                          </div>
                          <div className="conference-people" aria-label="Conference participants">
                            {displayParticipants.map((participant) => (
                              <div className={participant.state === 'Disconnected' ? 'participant-disconnected' : ''} key={participant.id}>
                                <span className="participant-avatar">{participant.name.charAt(0) || 'P'}</span>
                                <strong>{participant.isCurrentAgent ? 'You' : participant.name}</strong>
                                <small>{participant.held ? 'Held' : participant.state}</small>
                              </div>
                            ))}
                          </div>
                          <div className="conference-actions">
                            <button className="button secondary" disabled={busy !== ''} aria-expanded={participantsOpen} onClick={() => setParticipantsOpen((open) => !open)}>
                              <ControlIcon name="participants" /> {participantsOpen ? 'Hide participants' : 'Manage participants'}
                            </button>
                            <button className="button primary" disabled={busy !== '' || !snapshot.exitConferenceCapable} onClick={() => void run('exit-conference', async () => {
                              await controller.exitConference();
                              setParticipantsOpen(false);
                            })}>
                              Leave conference
                            </button>
                            <button className="button secondary" disabled={busy !== '' || !snapshot.transferConferenceCapable} onClick={() => void run('transfer-conference', () => controller.transferConference())}>
                              <ControlIcon name="transfer" /> Hand over conference
                            </button>
                          </div>
                          {participantsOpen && (
                            <div className="participant-manager">
                              {displayParticipants.map((participant) => (
                                <div className="participant-row" key={participant.id}>
                                  <span className="participant-avatar">{participant.name.charAt(0) || 'P'}</span>
                                  <div><strong>{participant.isCurrentAgent ? 'You' : participant.name}</strong><span>{participant.type} · {participant.held ? 'Held' : participant.state}</span></div>
                                  {participant.state === 'Disconnected' ? (
                                    <span className="neutral-chip">Left</span>
                                  ) : participant.isCurrentAgent ? (
                                    <span className="neutral-chip">Host</span>
                                  ) : (
                                    <button
                                      type="button"
                                      className="drop-participant"
                                      disabled={busy !== '' || !participant.id || participant.id === 'customer' || participant.id === 'consult'}
                                      title={participant.id === 'customer' || participant.id === 'consult' ? 'Participant data is still being synchronized by the SDK.' : 'Drop participant'}
                                      onClick={() => void run('drop-participant', () => controller.dropConferenceParticipant(participant.id))}
                                    >Drop</button>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                    </>
                  )}
                </>
              )}
            </>
          )}
        </section>

        {stationLoggedIn && activeInteraction && (
          <InteractionInsights
            key={snapshot.interactionId}
            snapshot={snapshot}
            controller={controller}
            busy={busy}
            run={run}
            summaryFocusRequest={summaryFocusRequest}
          />
        )}

        {stationLoggedIn && ['ringing', 'answering', 'connected', 'held', 'wrap-up'].includes(snapshot.callStatus) && (
          <section className="call-control-dock" aria-label="Call controls">
            {wrapupActive ? (
              <div className="dock-wrapup">
                <div className="dock-wrapup-copy">
                  <strong>Complete wrap-up</strong>
                  <span>Select a reason to finish this interaction.</span>
                </div>
                <SelectMenu
                  ariaLabel="Wrap-up reason"
                  value={snapshot.selectedWrapupCode}
                  options={wrapupMenuOptions}
                  placeholder="Select wrap-up reason"
                  onChange={(value) => controller.selectWrapupCode(value)}
                />
                <button
                  className="button primary"
                  disabled={!snapshot.selectedWrapupCode || busy !== ''}
                  onClick={() => run('wrapup', () => controller.wrapup())}
                >
                  {busy === 'wrapup' ? 'Completing…' : 'Complete'}
                </button>
              </div>
            ) : ['ringing', 'answering'].includes(snapshot.callStatus) ? (
              <div className="mobile-call-controls incoming-call-controls">
                <button
                  className="phone-control answer-call-control"
                  disabled={!canAnswer || busy !== ''}
                  onClick={() => run('answer', () => controller.answer())}
                >
                  <span><ControlIcon name="phone" /></span>
                  <small>{busy === 'answer' ? 'Answering…' : 'Answer'}</small>
                </button>
                <button
                  className="phone-control decline-call-control"
                  disabled={!canDecline || busy !== ''}
                  onClick={() => run('decline', () => controller.decline())}
                >
                  <span><ControlIcon name="phone" /></span>
                  <small>{busy === 'decline' ? 'Declining…' : 'Decline'}</small>
                </button>
              </div>
            ) : consultInitiatedByAgent ? (
              <>
                {dialpadOpen && (
                  <div className="dock-popover dialpad-popover">
                    <div id="dtmf-dialpad" className="dialpad" aria-label="DTMF dial pad">
                      {digits.map((digit) => (
                        <button
                          key={digit}
                          disabled={busy !== '' || !snapshot.dtmfCapable}
                          onClick={() => run(`dtmf-${digit}`, () => controller.sendDigit(digit))}
                        >{digit}</button>
                      ))}
                    </div>
                  </div>
                )}
                {consultConnecting ? (
                  <div className="consult-dock-status" role="status">
                    Waiting for the consult destination. Use Cancel beside the destination to stop waiting.
                  </div>
                ) : (
                  <div className="mobile-call-controls consult-dock-controls" aria-label="Consult controls">
                    {snapshot.muteCapable && (
                      <button
                        className={`phone-control ${snapshot.muted ? 'active' : ''}`}
                        disabled={busy !== ''}
                        onClick={() => run('mute', () => controller.toggleMute())}
                      >
                        <span><ControlIcon name="mute" /></span>
                        <small>{snapshot.muted ? 'Unmute' : 'Mute'}</small>
                      </button>
                    )}
                    {snapshot.holdCapable && (
                      <button
                        className={`phone-control ${snapshot.held ? 'active' : ''}`}
                        disabled={busy !== ''}
                        onClick={() => run('hold', () => controller.toggleHold())}
                      >
                        <span><ControlIcon name="hold" /></span>
                        <small>{snapshot.held ? 'Resume' : 'Hold'}</small>
                      </button>
                    )}
                    {snapshot.dtmfCapable && (
                      <button
                        className={`phone-control ${dialpadOpen ? 'active' : ''}`}
                        disabled={busy !== ''}
                        aria-expanded={dialpadOpen}
                        aria-controls="dtmf-dialpad"
                        onClick={() => setDialpadTaskId(dialpadOpen ? '' : snapshot.interactionId)}
                      >
                        <span><ControlIcon name="keypad" /></span>
                        <small>Keypad</small>
                      </button>
                    )}
                    {snapshot.switchCapable && (
                      <button className="phone-control" disabled={busy !== ''} onClick={() => run('switch-call', () => controller.switchCall())}>
                        <span><ControlIcon name="switch" /></span>
                        <small>Switch to {snapshot.activeLeg === 'consult' ? 'customer' : 'consult'}</small>
                      </button>
                    )}
                    {snapshot.conferenceCapable && (
                      <button className="phone-control conference-control" disabled={busy !== ''} onClick={() => {
                        setParticipantsOpen(false);
                        void run('conference', () => controller.startConference());
                      }}>
                        <span><ControlIcon name="conference" /></span>
                        <small>Conference</small>
                      </button>
                    )}
                    {snapshot.consultTransferCapable && (
                      <button className="phone-control transfer-control" disabled={busy !== ''} onClick={() => run('consult-transfer', () => controller.completeConsultTransfer())}>
                        <span><ControlIcon name="transfer" /></span>
                        <small>Complete transfer</small>
                      </button>
                    )}
                    {snapshot.transferConferenceCapable && (
                      <button className="phone-control transfer-control" disabled={busy !== ''} onClick={() => run('transfer-conference', () => controller.transferConference())}>
                        <span><ControlIcon name="transfer" /></span>
                        <small>Hand over conference</small>
                      </button>
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                {dialpadOpen && (
                  <div className="dock-popover dialpad-popover">
                    <div id="dtmf-dialpad" className="dialpad" aria-label="DTMF dial pad">
                      {digits.map((digit) => (
                        <button
                          key={digit}
                          disabled={busy !== '' || !snapshot.dtmfCapable}
                          onClick={() => run(`dtmf-${digit}`, () => controller.sendDigit(digit))}
                        >{digit}</button>
                      ))}
                    </div>
                  </div>
                )}

                {activeRouteMode && !snapshot.consultActive && (
                  <div className="dock-popover route-popover">
                    <div className="call-control-sheet">
                      <div className="sheet-heading">
                        <div>
                          <strong>{activeRouteMode === 'consult' ? 'Consult a destination' : 'Transfer call'}</strong>
                          <span>{activeRouteMode === 'consult' ? 'The caller will be held while you consult.' : 'This immediately transfers the interaction.'}</span>
                        </div>
                        <button type="button" aria-label="Close" onClick={() => setRouteMode('')}>
                          <ControlIcon name="close" />
                        </button>
                      </div>
                      <SelectMenu
                        ariaLabel={`${activeRouteMode} destination`}
                        value={destinationId}
                        options={destinationMenuOptions}
                        disabled={busy === 'destinations'}
                        placeholder={busy === 'destinations' ? 'Loading destinations…' : 'Select an agent or queue'}
                        onChange={setDestinationId}
                      />
                      {snapshot.destinationsLoaded && destinationMenuOptions.length === 0 && (
                        <p className="empty-destinations">No eligible agents or telephony queues were returned.</p>
                      )}
                      <button
                        className="button primary full sheet-submit"
                        disabled={!destinationId || busy !== ''}
                        onClick={() => run(activeRouteMode, async () => {
                          if (activeRouteMode === 'consult') await controller.consult(destinationId);
                          else await controller.transfer(destinationId);
                          setRouteMode('');
                          setRouteTaskId('');
                        })}
                      >
                        {activeRouteMode === 'consult' ? 'Start consult' : 'Transfer now'}
                      </button>
                    </div>
                  </div>
                )}

                <div className={`mobile-call-controls ${snapshot.conferenceActive ? 'conference-dock-controls' : ''}`}>
                  <button
                    className={`phone-control ${snapshot.muted ? 'active' : ''}`}
                    disabled={busy !== '' || !snapshot.muteCapable}
                    onClick={() => run('mute', () => controller.toggleMute())}
                  >
                    <span><ControlIcon name="mute" /></span>
                    <small>{snapshot.muted ? 'Unmute' : 'Mute'}</small>
                  </button>
                  <button
                    className={`phone-control ${snapshot.held ? 'active' : ''}`}
                    disabled={busy !== '' || !snapshot.holdCapable}
                    onClick={() => run('hold', () => controller.toggleHold())}
                  >
                    <span><ControlIcon name="hold" /></span>
                    <small>{snapshot.held ? 'Resume' : 'Hold'}</small>
                  </button>
                  <button
                    className={`phone-control ${dialpadOpen ? 'active' : ''}`}
                    disabled={busy !== '' || !snapshot.dtmfCapable}
                    title={
                      snapshot.dtmfCapable
                        ? 'Open DTMF keypad'
                        : snapshot.stationLoginOption === 'EXTENSION'
                          ? 'Waiting for the SDK to correlate the active Webex App call'
                          : 'DTMF is available for correlated Webex App calls'
                    }
                    aria-expanded={dialpadOpen}
                    aria-controls="dtmf-dialpad"
                    onClick={() => {
                      setRouteMode('');
                      setDialpadTaskId(dialpadOpen ? '' : snapshot.interactionId);
                    }}
                  >
                    <span><ControlIcon name="keypad" /></span>
                    <small>Keypad</small>
                  </button>
                  <button
                    className={`phone-control ${snapshot.recordingPaused ? 'active warning-active' : ''}`}
                    disabled={busy !== '' || !snapshot.recordingPauseCapable}
                    title={
                      snapshot.recordingPauseCapable
                        ? snapshot.recordingPaused ? 'Resume call recording' : 'Pause call recording'
                        : snapshot.recordingActive
                          ? 'Recording is active, but pause and resume are not permitted for this interaction'
                          : 'Recording has not started or pause and resume are not enabled'
                    }
                    onClick={() => run('recording', () => controller.toggleRecording())}
                  >
                    <span><ControlIcon name="record" /></span>
                    <small>{snapshot.recordingPaused ? 'Resume rec.' : 'Pause rec.'}</small>
                  </button>
                  <button
                    className={`phone-control ${activeRouteMode === 'consult' || snapshot.consultActive ? 'active' : ''}`}
                    disabled={busy !== '' || snapshot.consultActive || !snapshot.consultCapable}
                    title={snapshot.conferenceActive ? 'Add another participant through a consultation' : 'Consult an agent or queue'}
                    onClick={() => {
                      setDialpadTaskId('');
                      void openRoutePanel('consult');
                    }}
                  >
                    <span><ControlIcon name="consult" /></span>
                    <small>Consult</small>
                  </button>
                  {snapshot.conferenceActive && (
                    <button
                      className={`phone-control ${participantsOpen ? 'active' : ''}`}
                      disabled={busy !== ''}
                      aria-expanded={participantsOpen}
                      onClick={() => {
                        setRouteMode('');
                        setDialpadTaskId('');
                        setParticipantsOpen((open) => !open);
                      }}
                    >
                      <span><ControlIcon name="participants" /></span>
                      <small>Participants</small>
                    </button>
                  )}
                  <button
                    className={`phone-control ${activeRouteMode === 'transfer' ? 'active' : ''}`}
                    disabled={busy !== '' || snapshot.consultActive || !snapshot.transferCapable}
                    title={snapshot.conferenceActive && !snapshot.transferCapable
                      ? 'For a conference handover, consult a destination and then choose Hand over conference'
                      : 'Transfer the interaction'}
                    onClick={() => {
                      setDialpadTaskId('');
                      void openRoutePanel('transfer');
                    }}
                  >
                    <span><ControlIcon name="transfer" /></span>
                    <small>Transfer</small>
                  </button>
                </div>
                <button
                  className="phone-control decline-call-control end-call-control"
                  disabled={busy !== '' || !snapshot.endCapable}
                  onClick={() => run('end', () => controller.endCall())}
                >
                  <span><ControlIcon name="phone" /></span>
                  <small>{busy === 'end' ? 'Ending…' : 'End call'}</small>
                </button>
              </>
            )}
          </section>
        )}
      </div>

      {diagnosticsOpen && (
        <div className="drawer-scrim" onClick={() => setDiagnosticsOpen(false)}>
          <aside className="diagnostics-drawer" aria-label="Runtime diagnostics" onClick={(event) => event.stopPropagation()}>
            <div className="drawer-heading">
              <div><span className="section-kicker">Diagnostics</span><h2>Event timeline</h2></div>
              <button type="button" aria-label="Close diagnostics" onClick={() => setDiagnosticsOpen(false)}><ControlIcon name="close" /></button>
            </div>
            {snapshot.error && <div className="notice error-notice">{snapshot.error}</div>}
            <ol className="timeline">
              {snapshot.timeline.length === 0 && <li className="empty-event">Runtime events appear here.</li>}
              {snapshot.timeline.map((entry) => (
                <li key={entry.id} className={`event event-${entry.level}`}>
                  <time>{entry.at}</time><p>{entry.message}</p>
                </li>
              ))}
            </ol>
          </aside>
        </div>
      )}
    </main>
  );
}
