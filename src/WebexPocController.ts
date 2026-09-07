import type {ITask, Profile} from '@webex/contact-center';
import {reportBackendEvent} from './backendDiagnostics';
import {normalizeTeams} from './normalizers';
import {recoveredAgentSession} from './sessionRecovery';
import {
  initialSnapshot,
  type ControllerSnapshot,
  type InitializeOptions,
  type LifecycleStatus,
  type LogLevel,
  type StationLoginOption,
  type StationLoginOptions,
} from './types';

type SnapshotListener = (snapshot: ControllerSnapshot) => void;
type WebexInitializer = {init: (options: Record<string, unknown>) => any};
type ConsultTransferTask = ITask & {consultTransfer: () => Promise<unknown>};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown Webex error';
  }
}

function incomingNumber(task: ITask): string {
  const data = task.data as unknown as Record<string, any>;
  return (
    data.callProcessingDetails?.ani ||
    data.interaction?.callProcessingDetails?.ani ||
    data.interaction?.media?.[0]?.ani ||
    ''
  );
}

function incomingName(task: ITask): string {
  const data = task.data as unknown as Record<string, any>;
  const participants = Object.values(data.interaction?.participants ?? {}) as Array<Record<string, any>>;
  const customer = participants.find((participant) => participant.pType === 'Customer');
  return (
    data.callProcessingDetails?.customerName ||
    data.interaction?.callProcessingDetails?.customerName ||
    customer?.name ||
    customer?.pName ||
    ''
  );
}

function recordingPauseEnabled(task: ITask): boolean {
  const data = task.data as unknown as Record<string, any>;
  const value =
    data.interaction?.callProcessingDetails?.pauseResumeEnabled ??
    data.callProcessingDetails?.pauseResumeEnabled;
  return value === true || value === 'true' || value === 'TRUE';
}

function recordingPaused(task: ITask): boolean {
  const data = task.data as unknown as Record<string, any>;
  const value =
    data.interaction?.callProcessingDetails?.isPaused ??
    data.callProcessingDetails?.isPaused;
  return value === true || value === 'true' || value === 'TRUE';
}

function taskControlState(task: ITask) {
  const main = task.uiControls?.main;
  return {
    acceptCapable: Boolean(main?.accept?.isEnabled),
    declineCapable: Boolean(main?.decline?.isEnabled),
    holdCapable: Boolean(main?.hold?.isEnabled),
    endCapable: Boolean(main?.end?.isEnabled),
    muteCapable: Boolean(main?.mute?.isEnabled),
    dtmfCapable: Boolean(main?.keypad?.isEnabled),
  };
}

function profileLoginOptions(profile: Profile): StationLoginOption[] {
  const declared = (profile.loginVoiceOptions ?? []).filter(
    (option): option is StationLoginOption =>
      (option === 'BROWSER' && profile.webRtcEnabled === true) ||
      option === 'EXTENSION' ||
      option === 'AGENT_DN',
  );
  if (declared.length) return Array.from(new Set(declared));

  // Older profiles may omit loginVoiceOptions even when extension login is available.
  return profile.webRtcEnabled ? ['BROWSER', 'EXTENSION'] : ['EXTENSION'];
}

export class WebexPocController {
  private snapshot: ControllerSnapshot = structuredClone(initialSnapshot);
  private listeners = new Set<SnapshotListener>();
  private webex: any;
  private cc: any;
  private profile?: Profile;
  private task?: ITask;
  private logSequence = 0;
  private observedTasks = new WeakSet<ITask>();

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): ControllerSnapshot {
    return {...this.snapshot, timeline: [...this.snapshot.timeline]};
  }

  private update(patch: Partial<ControllerSnapshot>): void {
    this.snapshot = {...this.snapshot, ...patch};
    for (const listener of this.listeners) listener(this.getSnapshot());
  }

  private log(message: string, level: LogLevel = 'info'): void {
    this.logSequence += 1;
    this.update({
      timeline: [
        {id: this.logSequence, at: new Date().toLocaleTimeString(), level, message},
        ...this.snapshot.timeline,
      ].slice(0, 100),
    });
  }

  private fail(context: string, error: unknown, fatal = false): never {
    const message = `${context}: ${errorMessage(error)}`;
    this.update({error: message, ...(fatal ? {lifecycle: 'error' as const} : {})});
    this.log(message, 'error');
    throw error;
  }

  private setLifecycle(lifecycle: LifecycleStatus, agentState?: string): void {
    this.update({lifecycle, ...(agentState ? {agentState} : {})});
  }

  async initialize(options: InitializeOptions): Promise<void> {
    if (!options.accessToken.trim()) throw new Error('Complete Webex OAuth first.');

    this.setLifecycle('initializing', 'Initializing');
    this.update({
      error: '',
      lineStatus: 'Connecting to Contact Center',
    });
    this.log('Initializing Webex Contact Center with the OAuth session.');
    reportBackendEvent('cc.initialize', 'started');

    try {
      const {default: Webex} = await import('@webex/contact-center');
      const WebexSdk = Webex as unknown as WebexInitializer;
      this.webex = WebexSdk.init({
        credentials: {access_token: options.accessToken.trim()},
        config: {
          logger: {level: 'error'},
          cc: {
            allowMultiLogin: false,
            allowAutomatedRelogin: true,
            enableWxBetterTogether: true,
          },
        },
      });

      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('Webex ready event timed out.')), 30_000);
        this.webex.once('ready', () => {
          window.clearTimeout(timer);
          resolve();
        });
      });

      this.cc = this.webex.cc;
      this.attachContactCenterListeners();
      const profile = (await this.cc.register()) as Profile;
      this.profile = profile;
      const teams = normalizeTeams(profile.teams);
      const recovered = recoveredAgentSession(profile);
      const loginVoiceOptions = profileLoginOptions(profile);
      const selectedTeamId =
        teams.find((team) => team.id === recovered.teamId)?.id ?? teams[0]?.id ?? '';
      if (!selectedTeamId) throw new Error('No usable assigned team was returned for this agent.');
      const idleCodes = profile.idleCodes.filter((code) => code.id !== '0');
      const defaultIdleCode =
        idleCodes.find((code) => code.isDefault && !code.isSystem) ??
        idleCodes.find((code) => !code.isSystem) ??
        idleCodes[0];

      this.update({
        agentName: profile.agentName,
        teams,
        selectedTeamId,
        wrapupCodes: profile.wrapupCodes,
        selectedWrapupCode: profile.defaultWrapupCode || profile.wrapupCodes[0]?.id || '',
        idleCodes,
        selectedIdleCode: recovered.idleCodeId || defaultIdleCode?.id || '',
        stationLoginOption: recovered.deviceType,
        stationDialNumber: recovered.dialNumber,
        loginVoiceOptions,
        webRtcEnabled: profile.webRtcEnabled === true,
        lineStatus: recovered.loggedIn ? 'Station connected' : 'Ready for station login',
      });
      this.log(`Contact Center registered for ${profile.agentName}.`, 'success');
      if (recovered.loggedIn) {
        this.setLifecycle(recovered.lifecycle, recovered.agentState);
        this.log(
          `Existing Contact Center station session recovered (${recovered.deviceType || 'unknown device type'}).`,
          'success',
        );
        const tasks = Object.values(
          (this.cc.taskManager?.getAllTasks?.() ?? {}) as Record<string, ITask>,
        );
        reportBackendEvent('cc.initialize', 'succeeded', {
          stationRecovered: true,
          taskCount: tasks.length,
        });
        if (tasks.length === 1 && !this.task) this.restoreHydratedTask(tasks[0]);
        if (tasks.length > 1 && !this.task) {
          this.log(`Recovered ${tasks.length} tasks; waiting for SDK task hydration events.`, 'warning');
        }
      } else {
        this.setLifecycle('initialized', 'Ready for station login');
        this.log('No existing Contact Center station session was found.');
        reportBackendEvent('cc.initialize', 'succeeded', {stationRecovered: false});
      }
    } catch (error) {
      reportBackendEvent('cc.initialize', 'failed');
      this.fail('Initialization failed', error, true);
    }
  }

  selectTeam(teamId: string): void {
    this.update({selectedTeamId: teamId});
  }

  selectWrapupCode(codeId: string): void {
    this.update({selectedWrapupCode: codeId});
  }

  async stationLogin(options: StationLoginOptions): Promise<void> {
    if (!this.cc || !this.profile) throw new Error('Initialize Contact Center first.');
    if (!this.snapshot.selectedTeamId) throw new Error('Select an agent team.');
    if (!this.snapshot.loginVoiceOptions.includes(options.loginOption)) {
      throw new Error('This station login method is not enabled for the agent profile.');
    }
    if (options.loginOption === 'BROWSER' && !this.snapshot.webRtcEnabled) {
      throw new Error('Desktop calling is not enabled for this Contact Center organization.');
    }
    const dialNumber = options.dialNumber?.trim() ?? '';
    if (options.loginOption !== 'BROWSER' && !dialNumber) {
      throw new Error(
        options.loginOption === 'EXTENSION'
          ? 'Select or enter a Webex Calling extension.'
          : 'Enter the dial number that should receive Contact Center calls.',
      );
    }

    reportBackendEvent('cc.station_login', 'started', {deviceType: options.loginOption});
    try {
      const response = await this.cc.stationLogin({
        teamId: this.snapshot.selectedTeamId,
        loginOption: options.loginOption,
        ...(options.loginOption === 'BROWSER' ? {} : {dialNumber}),
      });
      const stationDialNumber = String(response?.dn || dialNumber);
      const endpointName =
        options.loginOption === 'BROWSER'
          ? 'This browser'
          : options.loginOption === 'AGENT_DN'
            ? 'Dial number'
            : options.answerEndpoint?.name || 'Webex Calling device';
      this.update({
        stationLoginOption: options.loginOption,
        stationDialNumber,
        endpointId: options.loginOption === 'EXTENSION' ? options.answerEndpoint?.id || '' : '',
        endpointName,
        lineStatus:
          options.loginOption === 'BROWSER'
            ? 'Browser audio registered'
            : options.loginOption === 'AGENT_DN'
              ? 'Dial number connected'
              : options.answerEndpoint?.status === 'CONNECTED'
                ? 'Webex endpoint registered'
                : 'Webex extension connected',
      });
      this.setLifecycle('station-logged-in', 'Idle');
      this.log(
        options.loginOption === 'BROWSER'
          ? 'Station logged in with browser audio.'
          : options.loginOption === 'AGENT_DN'
            ? 'Station logged in with a dial number.'
            : 'Station logged in with a Webex Calling extension.',
        'success',
      );
      reportBackendEvent('cc.station_login', 'succeeded', {deviceType: options.loginOption});
    } catch (error) {
      reportBackendEvent('cc.station_login', 'failed', {deviceType: options.loginOption});
      this.fail('Station login failed', error);
    }
  }

  async setAvailable(): Promise<void> {
    if (!this.cc || !this.profile) throw new Error('Station login is required.');
    try {
      await this.cc.setAgentState({
        state: 'Available',
        auxCodeId: '0',
        agentId: this.profile.agentId,
        lastStateChangeReason: 'Agent selected Available',
      });
      this.setLifecycle('available', 'Available');
      this.log('Agent is Available.', 'success');
      reportBackendEvent('cc.agent_state', 'succeeded', {state: 'available'});
    } catch (error) {
      reportBackendEvent('cc.agent_state', 'failed', {state: 'available'});
      this.fail('Changing agent state failed', error);
    }
  }

  async setIdle(codeId = this.snapshot.selectedIdleCode): Promise<void> {
    if (!this.cc || !this.profile) throw new Error('Station login is required.');
    const idleCode = this.profile.idleCodes.find(
      (code) => code.id === codeId && !code.isSystem,
    );
    if (!idleCode) throw new Error('No idle auxiliary code is available for this agent.');
    try {
      this.update({selectedIdleCode: idleCode.id});
      await this.cc.setAgentState({
        state: 'Idle',
        auxCodeId: idleCode.id,
        agentId: this.profile.agentId,
        lastStateChangeReason: `Agent selected ${idleCode.name}`,
      });
      this.setLifecycle('idle', idleCode.name);
      this.log(`Agent state changed to ${idleCode.name}.`, 'success');
      reportBackendEvent('cc.agent_state', 'succeeded', {state: 'idle'});
    } catch (error) {
      reportBackendEvent('cc.agent_state', 'failed', {state: 'idle'});
      this.fail('Changing agent state failed', error);
    }
  }

  async answer(): Promise<void> {
    if (!this.task || !this.snapshot.acceptCapable) {
      throw new Error('The Contact Center task is not ready to be answered on this station.');
    }
    this.update({callStatus: 'answering', error: ''});
    reportBackendEvent('cc.webex_call_control', 'started', {action: 'accept'});
    try {
      await this.task.accept();
      this.update({...taskControlState(this.task)});
      this.log('Call accepted through the Contact Center SDK.', 'success');
      reportBackendEvent('cc.webex_call_control', 'succeeded', {action: 'accept'});
    } catch (error) {
      this.update({callStatus: 'ringing', ...taskControlState(this.task)});
      reportBackendEvent('cc.webex_call_control', 'failed', {action: 'accept'});
      this.fail('Answer failed', error);
    }
  }

  async decline(): Promise<void> {
    if (!this.task || this.snapshot.callStatus !== 'ringing' || !this.snapshot.declineCapable) {
      throw new Error('The Contact Center task is not ready to be declined on Webex App.');
    }
    reportBackendEvent('cc.webex_call_control', 'started', {action: 'decline'});
    try {
      await this.task.decline();
      this.log('Call declined through the Contact Center SDK.', 'success');
      reportBackendEvent('cc.webex_call_control', 'succeeded', {action: 'decline'});
      this.clearCallState();
    } catch (error) {
      reportBackendEvent('cc.webex_call_control', 'failed', {action: 'decline'});
      this.fail('Decline failed', error);
    }
  }

  async toggleMute(): Promise<void> {
    if (!this.task || !this.snapshot.muteCapable) {
      throw new Error('Mute is not available for this Contact Center task.');
    }
    const targetMuted = !this.snapshot.muted;
    const action = targetMuted ? 'mute' : 'unmute';
    reportBackendEvent('cc.webex_call_control', 'started', {action});
    try {
      await this.task.toggleMute({muted: targetMuted});
      this.update({
        muted:
          this.snapshot.stationLoginOption === 'BROWSER'
            ? targetMuted
            : this.task.getWxAppMuted?.() ?? targetMuted,
      });
      this.log(action === 'mute' ? 'Call muted.' : 'Call unmuted.', 'success');
      reportBackendEvent('cc.webex_call_control', 'succeeded', {action});
    } catch (error) {
      reportBackendEvent('cc.webex_call_control', 'failed', {action});
      this.fail('Mute control failed', error);
    }
  }

  async sendDigit(digit: string): Promise<void> {
    if (!this.task || !this.snapshot.dtmfCapable) {
      throw new Error('DTMF is not available for this Contact Center task.');
    }
    reportBackendEvent('cc.webex_call_control', 'started', {action: 'dtmf'});
    try {
      await this.task.transmitDtmf({dtmf: digit});
      this.log(`DTMF ${digit} sent.`);
      reportBackendEvent('cc.webex_call_control', 'succeeded', {action: 'dtmf'});
    } catch (error) {
      reportBackendEvent('cc.webex_call_control', 'failed', {action: 'dtmf'});
      this.fail('DTMF failed', error);
    }
  }

  async toggleHold(): Promise<void> {
    if (!this.task || !this.snapshot.holdCapable) {
      throw new Error('Hold or resume is not available for this Contact Center task.');
    }
    const wasHeld = this.snapshot.held;
    const action = this.snapshot.held ? 'resume' : 'hold';
    reportBackendEvent('cc.webex_call_control', 'started', {action});
    try {
      if (wasHeld) await this.task.resume();
      else await this.task.hold();
      this.update({
        held: !wasHeld,
        callStatus: wasHeld ? 'connected' : 'held',
        ...taskControlState(this.task),
      });
      this.log(
        action === 'hold' ? 'Call held.' : 'Call resumed.',
        'success',
      );
      reportBackendEvent('cc.webex_call_control', 'succeeded', {action});
    } catch (error) {
      reportBackendEvent('cc.webex_call_control', 'failed', {action});
      this.fail('Hold/resume failed', error);
    }
  }

  async toggleRecording(): Promise<void> {
    if (!this.task || !['connected', 'held'].includes(this.snapshot.callStatus)) {
      throw new Error('A connected Contact Center task is required.');
    }
    if (!this.snapshot.recordingPauseCapable) {
      throw new Error('Pause and resume recording are not enabled for this interaction.');
    }
    try {
      const wasPaused = this.snapshot.recordingPaused;
      if (wasPaused) await this.task.resumeRecording({autoResumed: false});
      else await this.task.pauseRecording();
      this.update({recordingPaused: !wasPaused});
      this.log(wasPaused ? 'Recording resumed.' : 'Recording paused.', 'success');
      reportBackendEvent('cc.recording', 'succeeded', {action: wasPaused ? 'resume' : 'pause'});
    } catch (error) {
      reportBackendEvent('cc.recording', 'failed');
      this.fail('Recording control failed', error);
    }
  }

  async loadDestinations(): Promise<void> {
    if (!this.cc || !this.task) throw new Error('A Contact Center task is required.');
    try {
      const [queuesResult, agentsResult] = await Promise.allSettled([
        this.cc.getQueues({page: 0, pageSize: 100, desktopProfileFilter: true}),
        this.cc.getBuddyAgents({mediaType: 'telephony'}),
      ]);
      const queues = queuesResult.status === 'fulfilled'
        ? (queuesResult.value?.data ?? [])
            .filter((queue: any) => queue.id && queue.active && queue.channelType === 'TELEPHONY')
            .map((queue: any) => ({
              id: String(queue.id),
              name: String(queue.name || 'Unnamed queue'),
              type: 'queue' as const,
              detail: 'Queue',
            }))
        : [];
      const agents = agentsResult.status === 'fulfilled'
        ? (agentsResult.value?.data?.agentList ?? [])
            .filter((agent: any) => agent.agentId)
            .map((agent: any) => ({
              id: String(agent.agentId),
              name: String(agent.agentName || 'Unnamed agent'),
              type: 'agent' as const,
              detail: [agent.state, agent.teamName].filter(Boolean).join(' · ') || 'Agent',
            }))
        : [];
      const destinations = [...agents, ...queues];
      this.update({destinations, destinationsLoaded: true});
      this.log(`Loaded ${destinations.length} Contact Center transfer destinations.`);
      if (!destinations.length && queuesResult.status === 'rejected' && agentsResult.status === 'rejected') {
        throw queuesResult.reason;
      }
    } catch (error) {
      this.fail('Loading transfer destinations failed', error);
    }
  }

  async consult(destinationId: string): Promise<void> {
    if (!this.task) throw new Error('A Contact Center task is required.');
    const destination = this.snapshot.destinations.find((item) => item.id === destinationId);
    if (!destination) throw new Error('Select a consult destination.');
    try {
      await this.task.consult({
        to: destination.id,
        destinationType: destination.type,
        holdParticipants: true,
      });
      this.update({consultActive: true, consultDestinationName: destination.name});
      this.log(`Consult started with ${destination.name}.`, 'success');
      reportBackendEvent('cc.consult', 'succeeded', {destinationType: destination.type});
    } catch (error) {
      reportBackendEvent('cc.consult', 'failed');
      this.fail('Consult failed', error);
    }
  }

  async transfer(destinationId: string): Promise<void> {
    if (!this.task) throw new Error('A Contact Center task is required.');
    const destination = this.snapshot.destinations.find((item) => item.id === destinationId);
    if (!destination) throw new Error('Select a transfer destination.');
    try {
      await this.task.transfer({to: destination.id, destinationType: destination.type});
      this.log(`Transfer sent to ${destination.name}.`, 'success');
      reportBackendEvent('cc.transfer', 'succeeded', {destinationType: destination.type});
    } catch (error) {
      reportBackendEvent('cc.transfer', 'failed');
      this.fail('Transfer failed', error);
    }
  }

  async completeConsultTransfer(): Promise<void> {
    if (!this.task || !this.snapshot.consultActive) throw new Error('No active consultation.');
    try {
      await (this.task as ConsultTransferTask).consultTransfer();
      this.log('Consult transfer completed.', 'success');
      reportBackendEvent('cc.consult_transfer', 'succeeded');
    } catch (error) {
      reportBackendEvent('cc.consult_transfer', 'failed');
      this.fail('Consult transfer failed', error);
    }
  }

  async startConference(): Promise<void> {
    if (!this.task || !this.snapshot.consultActive) {
      throw new Error('An active consultation is required.');
    }
    try {
      await this.task.consultConference();
      this.update({consultActive: false, conferenceActive: true});
      this.log('Consultation merged into a conference.', 'success');
      reportBackendEvent('cc.conference', 'succeeded', {action: 'start'});
    } catch (error) {
      reportBackendEvent('cc.conference', 'failed', {action: 'start'});
      this.fail('Starting conference failed', error);
    }
  }

  async exitConference(): Promise<void> {
    if (!this.task || !this.snapshot.conferenceActive) throw new Error('No active conference.');
    try {
      await this.task.exitConference();
      this.update({conferenceActive: false, consultActive: false});
      this.log('Agent exited the conference.', 'success');
      reportBackendEvent('cc.conference', 'succeeded', {action: 'exit'});
    } catch (error) {
      reportBackendEvent('cc.conference', 'failed', {action: 'exit'});
      this.fail('Exiting conference failed', error);
    }
  }

  async endConsult(): Promise<void> {
    if (!this.task || !this.snapshot.consultActive) throw new Error('No active consultation.');
    try {
      await this.task.endConsult({isConsult: true, taskId: this.task.data.interactionId});
      this.update({consultActive: false, consultDestinationName: ''});
      this.log('Consult ended.', 'success');
      reportBackendEvent('cc.consult_end', 'succeeded');
    } catch (error) {
      reportBackendEvent('cc.consult_end', 'failed');
      this.fail('Ending consult failed', error);
    }
  }

  async endCall(): Promise<void> {
    if (!this.task || !this.snapshot.endCapable) {
      throw new Error('End is not available for this Contact Center task.');
    }
    reportBackendEvent('cc.webex_call_control', 'started', {action: 'end'});
    try {
      await this.task.end();
      this.log('Contact Center task end completed.', 'success');
      reportBackendEvent('cc.webex_call_control', 'succeeded', {action: 'end'});
    } catch (error) {
      reportBackendEvent('cc.webex_call_control', 'failed', {action: 'end'});
      this.fail('End call failed', error);
    }
  }

  async wrapup(): Promise<void> {
    if (!this.task) throw new Error('No Contact Center task is available for wrap-up.');
    const code = this.profile?.wrapupCodes.find(
      (candidate) => candidate.id === this.snapshot.selectedWrapupCode,
    );
    if (!code) throw new Error('Select a wrap-up code.');
    try {
      await this.task.wrapup({wrapUpReason: code.name, auxCodeId: code.id});
      this.log(`Wrap-up submitted: ${code.name}.`, 'success');
      reportBackendEvent('cc.wrapup', 'succeeded');
      this.clearCallState();
    } catch (error) {
      reportBackendEvent('cc.wrapup', 'failed');
      this.fail('Wrap-up failed', error);
    }
  }

  async logout(): Promise<void> {
    if (!['none', 'ended'].includes(this.snapshot.callStatus)) {
      throw new Error('End and wrap up the active task before logging out.');
    }
    const wasStationLoggedIn = ['station-logged-in', 'available', 'idle'].includes(
      this.snapshot.lifecycle,
    );
    this.setLifecycle('logging-out', 'Logging out');
    reportBackendEvent('cc.logout', 'started');
    this.log('Starting ordered station cleanup.');
    try {
      if (this.cc && wasStationLoggedIn) {
        await this.cc.stationLogout({logoutReason: 'User requested logout'});
      }
      if (this.cc) await this.cc.deregister();
      this.webex = undefined;
      this.cc = undefined;
      this.profile = undefined;
      this.task = undefined;
      this.snapshot = {...structuredClone(initialSnapshot), timeline: this.snapshot.timeline};
      this.log('Contact Center station and SDK session cleared.', 'success');
      this.setLifecycle('signed-out', 'Signed out');
      reportBackendEvent('cc.logout', 'succeeded');
    } catch (error) {
      reportBackendEvent('cc.logout', 'failed');
      this.fail('Logout failed', error, true);
    }
  }

  private attachContactCenterListeners(): void {
    this.cc.on('agent:stateChange', (event: any) => {
      const auxCodeId = String(event?.auxCodeId ?? '');
      const rawState = event?.subStatus ?? event?.state ?? 'Unknown';
      const idleCode = this.profile?.idleCodes.find((code) => code.id === auxCodeId);
      const state = auxCodeId === '0' || rawState === 'Available'
        ? 'Available'
        : idleCode?.name || rawState;
      const lifecycle = state === 'Available' ? 'available' : 'idle';
      this.update({agentState: state, lifecycle, ...(idleCode ? {selectedIdleCode: idleCode.id} : {})});
      this.log(`WxCC agent state event: ${state}.`);
    });
    this.cc.on('task:incoming', (task: ITask) => {
      this.task = task;
      this.attachTaskListeners(task);
      const interactionId = task.data.interactionId;
      this.update({
        activeTask: task,
        interactionId,
        callStatus: 'ringing',
        callerName: incomingName(task),
        callerNumber: incomingNumber(task),
        ...taskControlState(task),
        muted: task.getWxAppMuted?.() ?? false,
        recordingPauseCapable: recordingPauseEnabled(task),
        recordingPaused: false,
        consultActive: false,
        conferenceActive: false,
        consultDestinationName: '',
        destinations: [],
        destinationsLoaded: false,
        remoteAudioTrack: undefined,
        error: '',
      });
      this.log(`WxCC task offered: ${interactionId}.`, 'success');
      reportBackendEvent('cc.task', 'observed', {state: 'ringing'});
    });
    this.cc.on('task:hydrate', (task: ITask) => {
      this.restoreHydratedTask(task);
    });
  }

  private restoreHydratedTask(task: ITask): void {
    this.task = task;
    this.attachTaskListeners(task);
    const data = task.data as unknown as Record<string, any>;
    const interaction = data.interaction ?? {};
    const state = String(interaction.state ?? '').toLowerCase();
    const terminated = interaction.isTerminated === true;
    const wrapup = terminated && data.wrapUpRequired === true;
    const callStatus = wrapup
      ? 'wrap-up'
      : terminated
        ? 'ended'
        : state === 'new'
          ? 'ringing'
          : state.includes('hold')
            ? 'held'
            : 'connected';

    this.update({
      activeTask: task,
      interactionId: task.data.interactionId,
      callStatus,
      callerName: incomingName(task),
      callerNumber: incomingNumber(task),
      ...taskControlState(task),
      muted: task.getWxAppMuted?.() ?? false,
      recordingPauseCapable: recordingPauseEnabled(task),
      recordingPaused: recordingPaused(task),
      held: callStatus === 'held',
      consultActive: Boolean(data.isConsulted) && !(data.isConferencing || data.isConferenceInProgress),
      conferenceActive: Boolean(data.isConferencing || data.isConferenceInProgress),
      remoteAudioTrack: undefined,
      error: '',
    });
    this.log(`WxCC task hydrated after session recovery (${state || 'active'}).`, 'success');
    reportBackendEvent('cc.task', 'observed', {state: callStatus});
  }

  private attachTaskListeners(task: ITask): void {
    if (this.observedTasks.has(task)) return;
    this.observedTasks.add(task);

    task.on('task:ui-controls-updated', () => {
      if (this.task === task) this.update(taskControlState(task));
    });
    task.on('task:wxapp-mute-state-updated', (event: {muted?: boolean}) => {
      if (this.task === task && typeof event?.muted === 'boolean') {
        this.update({muted: event.muted});
      }
    });
    task.on('task:media', (track: MediaStreamTrack) => {
      if (this.task === task && track?.kind === 'audio') {
        this.update({remoteAudioTrack: track});
        this.log('Browser call audio is connected.', 'success');
      }
    });

    task.on('task:established', () => {
      this.update({callStatus: 'connected', ...taskControlState(task)});
      this.log('WxCC task established.', 'success');
    });
    task.on('task:hold', () =>
      this.update({held: true, callStatus: 'held', ...taskControlState(task)}),
    );
    task.on('task:resume', () =>
      this.update({held: false, callStatus: 'connected', ...taskControlState(task)}),
    );
    task.on('task:recordingPaused', () => this.update({recordingPaused: true}));
    task.on('task:recordingResumed', () => this.update({recordingPaused: false}));
    task.on('task:consultCreated', () => this.update({consultActive: true}));
    task.on('task:consulting', () => this.update({consultActive: true}));
    task.on('task:consultEnd', () =>
      this.update({consultActive: false, consultDestinationName: ''}),
    );
    task.on('task:conferenceStarted', () =>
      this.update({consultActive: false, conferenceActive: true}),
    );
    task.on('task:conferenceEnded', () =>
      this.update({consultActive: false, conferenceActive: false}),
    );
    task.on('task:wrapup', () => {
      this.update({callStatus: 'wrap-up'});
      this.log('WxCC task entered wrap-up.');
    });
    task.on('task:wrappedup', () => {
      this.log('WxCC task wrap-up completed.', 'success');
      this.clearCallState();
    });
    task.on('task:end', (endedTask?: ITask) => {
      const currentTask = endedTask ?? task;
      this.task = currentTask;

      if (currentTask.data.wrapUpRequired) {
        this.update({activeTask: currentTask, callStatus: 'wrap-up'});
        this.log('WxCC task ended; waiting for wrap-up.');
        return;
      }

      this.log('WxCC task ended; no wrap-up is required.', 'success');
      this.clearCallState();
    });
    task.on('task:error', (error: unknown) =>
      this.log(`WxCC task error: ${errorMessage(error)}`, 'error'),
    );
  }

  private clearCallState(): void {
    this.task = undefined;
    this.update({
      callStatus: 'none',
      interactionId: '',
      callerName: '',
      callerNumber: '',
      acceptCapable: false,
      declineCapable: false,
      holdCapable: false,
      endCapable: false,
      muted: false,
      held: false,
      muteCapable: false,
      dtmfCapable: false,
      recordingPaused: false,
      recordingPauseCapable: false,
      consultActive: false,
      conferenceActive: false,
      consultDestinationName: '',
      destinations: [],
      destinationsLoaded: false,
      activeTask: undefined,
      remoteAudioTrack: undefined,
    });
  }
}
