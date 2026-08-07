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
import {clearRecoveryIntent, readRecoveryIntent, saveRecoveryIntent} from './sessionRecovery';
import type {InitializeOptions, LifecycleStatus} from './types';

const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

function associationLabel(kind: string): string {
  if (kind === 'wxcc') return 'Webex App call matched';
  if (kind === 'locating') return 'Locating Webex App call…';
  if (kind === 'ambiguous') return 'Multiple calls found';
  return 'No Calling call associated';
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
  const [dialpadCallId, setDialpadCallId] = useState('');
  const [routeMode, setRouteMode] = useState<'consult' | 'transfer' | ''>('');
  const [routeCallId, setRouteCallId] = useState('');
  const [destinationId, setDestinationId] = useState('');
  const [banner, setBanner] = useState<{kind: 'error'; message: string}>();
  const [form, setForm] = useState<InitializeOptions>({accessToken: '', extension: ''});
  const recoveryAttempted = useRef(false);

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
        console.error('[webex-poc] OAuth status request failed.');
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
        if (value) setForm((current) => ({...current, extension: value}));
        setAnswerEndpointId(defaultEndpointId(configuration, primary));
      })
      .catch((error) => {
        if (!cancelled) {
          console.error('[webex-poc] Station configuration request failed.');
          setCallingConfigurationError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [oauth?.authenticated]);

  useEffect(() => {
    if (!oauth?.authenticated || recoveryAttempted.current) return;
    recoveryAttempted.current = true;
    const intent = readRecoveryIntent();
    if (!intent) {
      return;
    }

    const recover = async () => {
      await Promise.resolve();
      setBusy('recovery');
      setBanner(undefined);
      try {
        await controller.initialize({
          accessToken: oauth.accessToken,
          extension: intent.extension,
          answerEndpoint: intent.answerEndpoint,
        });
        const recoveredSnapshot = controller.getSnapshot();
        saveRecoveryIntent({
          accessToken: '',
          extension: recoveredSnapshot.extension || intent.extension,
          answerEndpoint: intent.answerEndpoint,
        });
      } catch (error) {
        console.error('[webex-poc] Contact Center session recovery failed.');
        setBanner({
          kind: 'error',
          message: `The previous session could not be restored. Check the extension and initialize again. ${
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

  const canAnswer = snapshot.callStatus === 'ringing' && snapshot.callKind === 'wxcc';
  const canDecline = snapshot.callStatus === 'ringing' && Boolean(snapshot.callId);
  const callAlerts = useCallAlerts({
    ringing: snapshot.callStatus === 'ringing',
    callKey: snapshot.interactionId || snapshot.callId,
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
    ['ringing', 'answering', 'connected', 'held', 'wrap-up'].includes(snapshot.callStatus);
  const hasCall = snapshot.callStatus !== 'none';
  const wrapupActive = snapshot.callStatus === 'wrap-up';
  const selectedTeam = snapshot.teams.find((team) => team.id === snapshot.selectedTeamId);
  const headerStatus = sessionStatus(snapshot.lifecycle, snapshot.agentState);
  const extensionOptions = configuredExtensions(callingConfiguration);
  const selectedExtension = extensionOptions.find(
    (candidate) => stationValue(candidate) === form.extension,
  );
  const answerEndpointOptions = endpointsForExtension(callingConfiguration, selectedExtension);
  const selectedEndpoint = answerEndpointOptions.find(
    (endpoint) => endpoint.id === answerEndpointId,
  );
  const endpointAlreadyPreferred = Boolean(
    selectedEndpoint && selectedEndpoint.id === callingConfiguration?.preferred?.id,
  );
  const selectableIdleCodes = snapshot.idleCodes.filter((code) => !code.isSystem);
  const dialpadOpen = Boolean(snapshot.callId && dialpadCallId === snapshot.callId);
  const activeRouteMode = routeCallId === snapshot.callId ? routeMode : '';
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
  const topbarSubtitle = !initialized
    ? 'Contact Center + Calling REST controls'
    : `Extension ${snapshot.extension}${stationLoggedIn && selectedTeam ? ` · ${selectedTeam.name}` : ''}`;

  const selectExtension = (extension: string) => {
    const configuration = callingConfiguration;
    const selected = extensionOptions.find((candidate) => stationValue(candidate) === extension);
    setForm({...form, extension});
    setAnswerEndpointId(defaultEndpointId(configuration, selected));
    setRememberEndpoint(false);
  };

  const initialize = async () => {
    if (rememberEndpoint && selectedEndpoint) {
      await setPreferredAnswerEndpoint(selectedEndpoint.id);
      setCallingConfiguration((current) =>
        current ? {...current, preferred: selectedEndpoint} : current,
      );
      setRememberEndpoint(false);
    }
    const options: InitializeOptions = {
      ...form,
      answerEndpoint: selectedEndpoint
        ? {
            id: selectedEndpoint.id,
            name: selectedEndpoint.name || 'Selected Webex endpoint',
            type: selectedEndpoint.type,
            status: selectedEndpoint.status,
          }
        : undefined,
    };
    await controller.initialize(options);
    saveRecoveryIntent(options);
  };

  const openRoutePanel = async (mode: 'consult' | 'transfer') => {
    setRouteMode(mode);
    setRouteCallId(snapshot.callId);
    setDestinationId('');
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
            profile: {displayName: '', email: ''},
          }
        : current,
    );
    setCallingConfiguration(undefined);
    setCallingConfigurationError('');
    setAnswerEndpointId('');
    setRememberEndpoint(false);
    setDialpadCallId('');
    setRouteMode('');
    setRouteCallId('');
    setDestinationId('');
    setForm({accessToken: '', extension: ''});
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
            Sign in to authorize Contact Center widgets and Webex Calling call controls.
          </p>
          {!oauth.configured && (
            <div className="notice error-notice">
              Configure WEBEX_CLIENT_ID and WEBEX_CLIENT_SECRET in the server environment first.
            </div>
          )}
          <button
            className="button primary oauth-button"
            disabled={!oauth.configured}
            onClick={() => window.location.assign('/api/oauth/login')}
          >
            Continue with Webex
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
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
          <span className={`agent-presence ${headerStatus.className}`}>{headerStatus.label}</span>
          <button
            type="button"
            className={`topbar-tool ${callAlerts.enabled ? 'is-active' : ''}`}
            aria-pressed={callAlerts.enabled}
            title={
              callAlerts.enabled
                ? `Call alerts enabled${callAlerts.permission === 'denied' ? ' · system notifications blocked' : ''}`
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
            className="topbar-tool"
            title={`Theme: ${theme.mode}. Change theme`}
            onClick={theme.cycle}
          >
            <ControlIcon name="theme" />
            <span>{theme.mode === 'system' ? 'Auto' : theme.mode}</span>
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

      <div className="console-layout">
        <section className="panel flow-panel">
          {!stationLoggedIn ? (
            <>
              <div className="panel-heading">
                <div>
                  <p className="section-kicker">Station setup</p>
                  <h2>{initialized ? 'Choose your agent team' : 'Choose / enter your extension'}</h2>
                </div>
                <span className={initialized ? 'pending-chip' : 'neutral-chip'}>
                  {initialized ? 'Station login required' : 'CC not initialized'}
                </span>
              </div>

              {oauth.profileError && (
                <div className="notice warning-notice profile-warning">
                  Calling profile unavailable{oauth.profileError.status ? ` · HTTP ${oauth.profileError.status}` : ''}
                </div>
              )}

              {!initialized ? (
                <div className="station-configuration">
                  <div className="station-selection-grid">
                    <label>
                      Calling extension
                      {extensionOptions.length > 0 ? (
                        <SelectMenu
                          ariaLabel="Calling extension"
                          value={form.extension}
                          options={extensionMenuOptions}
                          placeholder="Select a Calling extension"
                          onChange={selectExtension}
                        />
                      ) : (
                        <input
                          inputMode="tel"
                          placeholder="Enter your Calling extension"
                          value={form.extension}
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
                        placeholder={answerEndpointOptions.length ? 'Select an answer device' : 'Primary device fallback'}
                        onChange={(value) => {
                          setAnswerEndpointId(value);
                          setRememberEndpoint(false);
                        }}
                      />
                    </label>
                  </div>
                  {selectedEndpoint && (
                    <label
                      className={`remember-endpoint ${endpointAlreadyPreferred ? 'current-preference' : ''}`}
                    >
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
                  <button
                    className="button primary initialize-button"
                    disabled={
                      busy !== '' ||
                      !form.extension.trim() ||
                      (answerEndpointOptions.length > 0 && !selectedEndpoint)
                    }
                    onClick={() => run('initialize', initialize)}
                  >
                    {busy === 'recovery'
                      ? 'Restoring session…'
                      : busy === 'initialize'
                        ? 'Initializing…'
                        : 'Initialize Contact Center'}
                  </button>
                </div>
              ) : (
                <div className="setup-action">
                  <label>
                    Agent team
                    <SelectMenu
                      ariaLabel="Agent team"
                      value={snapshot.selectedTeamId}
                      options={teamMenuOptions}
                      onChange={(value) => controller.selectTeam(value)}
                    />
                  </label>
                  <button
                    className="button primary"
                    disabled={busy !== '' || !snapshot.selectedTeamId}
                    onClick={() => run('station-login', () => controller.stationLogin())}
                  >
                    {busy === 'station-login' ? 'Signing in…' : 'Station login'}
                  </button>
                </div>
              )}

              {!initialized && selectedEndpoint && (
                <div className="calling-device">
                  <span>Calling device</span>
                  <strong>{selectedEndpoint.name || selectedEndpoint.type || 'Assigned endpoint'}</strong>
                  <span className={`device-status status-${selectedEndpoint.status?.toLowerCase()}`}>
                    {selectedEndpoint.status === 'CONNECTED'
                      ? 'Registered'
                      : selectedEndpoint.status === 'NOT_CONNECTED'
                        ? 'Not registered'
                        : 'Available'}
                  </span>
                </div>
              )}
              {!initialized && callingConfigurationError && (
                <div className="notice warning-notice">
                  Calling extensions could not be loaded. Enter the extension manually.
                </div>
              )}

              {initialized && (
                <dl className="facts station-facts">
                  <div><dt>Extension</dt><dd>{snapshot.extension}</dd></div>
                  <div><dt>Answer endpoint</dt><dd>{snapshot.endpointName || 'Primary device fallback'}</dd></div>
                  <div><dt>Calling REST</dt><dd>{snapshot.lineStatus}</dd></div>
                </dl>
              )}
            </>
          ) : (
            <>
              <div className="panel-heading workspace-heading">
                <div>
                  <p className="section-kicker">Agent workspace</p>
                  <h2>{wrapupActive ? 'Wrap up interaction' : 'Agent controls'}</h2>
                </div>
                <label className="state-selector">
                  Agent state
                  <SelectMenu
                    ariaLabel="Agent state"
                    disabled={activeInteraction || busy !== ''}
                    value={
                      snapshot.agentState === 'Available'
                        ? 'available'
                        : snapshot.selectedIdleCode
                          ? `idle:${snapshot.selectedIdleCode}`
                          : 'idle'
                    }
                    options={stateMenuOptions}
                    onChange={(value) => {
                      void run('agent-state', () =>
                        value === 'available'
                          ? controller.setAvailable()
                          : controller.setIdle(value.replace(/^idle:/, '')),
                      );
                    }}
                  />
                </label>
              </div>

              {!hasCall ? (
                <div className="ready-state">
                  <div className="status-orb" aria-hidden="true"><span /></div>
                  <div>
                    <strong>{snapshot.agentState === 'Available' ? 'Ready for an incoming task' : 'Agent is idle'}</strong>
                    <span>
                      {snapshot.agentState === 'Available'
                        ? 'Contact Center is listening for interactions. Calling controls remain idle until a task arrives.'
                        : 'Change the agent state to Available when you are ready to receive calls.'}
                    </span>
                  </div>
                </div>
              ) : (
                <>
                  <div className={`call-card call-${snapshot.callStatus}`}>
                    <div className="avatar">{snapshot.callerName.charAt(0) || 'W'}</div>
                    <div className="caller-copy">
                      <strong>{snapshot.callerName || 'Contact Center caller'}</strong>
                      <span>{snapshot.callerNumber || 'Number unavailable'}</span>
                    </div>
                    <span className="call-state">{snapshot.callStatus}</span>
                  </div>

                  <div className={`association association-${snapshot.callKind}`}>
                    {associationLabel(snapshot.callKind)}
                  </div>

                  <div className="id-grid">
                    <div><span>WxCC interactionId</span><code title={snapshot.interactionId}>{snapshot.interactionId || '—'}</code></div>
                    <div><span>Calling callId</span><code title={snapshot.callId}>{snapshot.callId || '—'}</code></div>
                  </div>

                  {wrapupActive ? (
                    <div className="wrapup-panel">
                      <p>Calling media has ended. Complete the Contact Center task with a wrap-up reason.</p>
                      <div className="wrapup-row">
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
                          {busy === 'wrapup' ? 'Completing…' : 'Complete wrap-up'}
                        </button>
                      </div>
                    </div>
                  ) : snapshot.callStatus === 'ended' ? (
                    <div className="notice pending-notice">
                      Calling media has ended. Waiting for Contact Center to confirm whether wrap-up is required.
                    </div>
                  ) : (
                    <>
                      {['ringing', 'answering'].includes(snapshot.callStatus) && (
                      <div className="button-row call-actions">
                        <button
                          className="call-primary-action answer-call"
                          disabled={!canAnswer || busy !== ''}
                          onClick={() => run('answer', () => controller.answer())}
                        >
                          <span className="call-action-icon"><ControlIcon name="phone" /></span>
                          <span>{busy === 'answer' ? 'Answering…' : 'Answer'}</span>
                        </button>
                        <button
                          className="call-primary-action decline-call"
                          disabled={!canDecline || busy !== ''}
                          onClick={() => run('decline', () => controller.decline())}
                        >
                          <span className="call-action-icon"><ControlIcon name="phone" /></span>
                          <span>{busy === 'decline' ? 'Declining…' : 'Decline'}</span>
                        </button>
                      </div>
                      )}

                      {['connected', 'held'].includes(snapshot.callStatus) && (
                      <div className="mobile-call-controls">
                        <button
                          className={`phone-control ${snapshot.muted ? 'active' : ''}`}
                          disabled={busy !== '' || !snapshot.muteCapable || !['connected', 'held'].includes(snapshot.callStatus)}
                          onClick={() => run('mute', () => controller.toggleMute())}
                        >
                          <span><ControlIcon name="mute" /></span>
                          <small>{snapshot.muted ? 'Unmute' : 'Mute'}</small>
                        </button>
                        <button
                          className={`phone-control ${snapshot.held ? 'active' : ''}`}
                          disabled={busy !== '' || !snapshot.callId || !['connected', 'held'].includes(snapshot.callStatus)}
                          onClick={() => run('hold', () => controller.toggleHold())}
                        >
                          <span><ControlIcon name="hold" /></span>
                          <small>{snapshot.held ? 'Resume' : 'Hold'}</small>
                        </button>
                        <button
                          className={`phone-control ${dialpadOpen ? 'active' : ''}`}
                          disabled={busy !== '' || snapshot.callStatus !== 'connected'}
                          aria-expanded={dialpadOpen}
                          aria-controls="dtmf-dialpad"
                          onClick={() => {
                            setRouteMode('');
                            setDialpadCallId(dialpadOpen ? '' : snapshot.callId);
                          }}
                        >
                          <span><ControlIcon name="keypad" /></span>
                          <small>Keypad</small>
                        </button>
                        <button
                          className={`phone-control ${snapshot.recordingPaused ? 'active warning-active' : ''}`}
                          disabled={busy !== '' || !snapshot.recordingPauseCapable}
                          title={snapshot.recordingPauseCapable ? '' : 'Recording pause is not enabled for this interaction'}
                          onClick={() => run('recording', () => controller.toggleRecording())}
                        >
                          <span><ControlIcon name="record" /></span>
                          <small>{snapshot.recordingPaused ? 'Resume rec.' : 'Pause rec.'}</small>
                        </button>
                        <button
                          className={`phone-control ${activeRouteMode === 'consult' || snapshot.consultActive ? 'active' : ''}`}
                          disabled={busy !== '' || snapshot.consultActive}
                          onClick={() => {
                            setDialpadCallId('');
                            void openRoutePanel('consult');
                          }}
                        >
                          <span><ControlIcon name="consult" /></span>
                          <small>Consult</small>
                        </button>
                        <button
                          className={`phone-control ${activeRouteMode === 'transfer' ? 'active' : ''}`}
                          disabled={busy !== '' || snapshot.consultActive}
                          onClick={() => {
                            setDialpadCallId('');
                            void openRoutePanel('transfer');
                          }}
                        >
                          <span><ControlIcon name="transfer" /></span>
                          <small>Transfer</small>
                        </button>
                      </div>
                      )}

                      {dialpadOpen && (
                        <div id="dtmf-dialpad" className="dialpad" aria-label="DTMF dial pad">
                          {digits.map((digit) => (
                            <button
                              key={digit}
                              disabled={busy !== '' || snapshot.callStatus !== 'connected'}
                              onClick={() => run(`dtmf-${digit}`, () => controller.sendDigit(digit))}
                            >{digit}</button>
                          ))}
                        </div>
                      )}

                      {activeRouteMode && !snapshot.consultActive && (
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
                              setRouteCallId('');
                            })}
                          >
                            {activeRouteMode === 'consult' ? 'Start consult' : 'Transfer now'}
                          </button>
                        </div>
                      )}

                      {snapshot.consultActive && (
                        <div className="consult-session">
                          <div><strong>Consultation active</strong><span>{snapshot.consultDestinationName || 'Connected destination'}</span></div>
                          <div>
                            <button className="button secondary" disabled={busy !== ''} onClick={() => run('end-consult', () => controller.endConsult())}>End consult</button>
                            <button className="button primary" disabled={busy !== ''} onClick={() => run('consult-transfer', () => controller.completeConsultTransfer())}>Complete transfer</button>
                          </div>
                        </div>
                      )}

                      {['connected', 'held'].includes(snapshot.callStatus) && (
                        <button
                          className="end-call-button"
                          disabled={busy !== '' || !snapshot.callId}
                          onClick={() => run('end', () => controller.endCall())}
                        >
                          <span><ControlIcon name="phone" /></span>
                          End call
                        </button>
                      )}
                    </>
                  )}
                </>
              )}
            </>
          )}
        </section>

        <details className="panel diagnostics-panel">
          <summary>
            <span><span className="section-kicker">Diagnostics</span>Event timeline</span>
            <span className="event-count">{snapshot.error ? 'Needs attention' : snapshot.timeline.length}</span>
          </summary>
          {snapshot.error && <div className="notice error-notice">{snapshot.error}</div>}
          <ol className="timeline">
            {snapshot.timeline.length === 0 && <li className="empty-event">Runtime events appear here.</li>}
            {snapshot.timeline.map((entry) => (
              <li key={entry.id} className={`event event-${entry.level}`}>
                <time>{entry.at}</time><p>{entry.message}</p>
              </li>
            ))}
          </ol>
        </details>
      </div>
    </main>
  );
}
