import Webex, {type ITask, type Profile} from '@webex/contact-center';
import {selectIncomingCall, selectRecoverableCall} from './callMatching';
import {CallingApiClient, type CallingRestCall} from './callingApi';
import {reportBackendEvent} from './backendDiagnostics';
import {normalizeTeams} from './normalizers';
import {recoveredAgentSession} from './sessionRecovery';
import {
  initialSnapshot,
  type ControllerSnapshot,
  type InitializeOptions,
  type LifecycleStatus,
  type LogLevel,
} from './types';

type SnapshotListener = (snapshot: ControllerSnapshot) => void;
type WebexInitializer = {init: (options: Record<string, unknown>) => any};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown Webex error';
  }
}

function restCallId(call: CallingRestCall): string {
  return call.callId || call.id || '';
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

export class WebexPocController {
  private snapshot: ControllerSnapshot = structuredClone(initialSnapshot);
  private listeners = new Set<SnapshotListener>();
  private webex: any;
  private cc: any;
  private profile?: Profile;
  private task?: ITask;
  private api = new CallingApiClient();
  private callPollTimer?: number;
  private missingCallPolls = 0;
  private offerGeneration = 0;
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
    if (!options.extension.trim()) throw new Error('A Calling extension is required.');

    this.setLifecycle('initializing', 'Initializing');
    this.update({
      error: '',
      extension: options.extension.trim(),
      endpointId: options.answerEndpoint?.id || '',
      endpointName: options.answerEndpoint?.name || 'Primary device fallback',
      lineStatus: options.answerEndpoint
        ? options.answerEndpoint.status === 'CONNECTED'
          ? 'Selected endpoint registered'
          : 'Selected endpoint ready'
        : 'Primary device fallback',
    });
    this.log('Initializing Webex Contact Center with the OAuth session.');
    reportBackendEvent('cc.initialize', 'started', {
      hasAnswerEndpoint: Boolean(options.answerEndpoint?.id),
    });
    this.log(
      options.answerEndpoint
        ? `Answer endpoint selected: ${options.answerEndpoint.name}.`
        : 'No answer endpoint selected; Answer will use the primary device.',
      options.answerEndpoint ? 'success' : 'warning',
    );

    try {
      const WebexSdk = Webex as unknown as WebexInitializer;
      this.webex = WebexSdk.init({
        credentials: {access_token: options.accessToken.trim()},
        config: {
          logger: {level: 'error'},
          cc: {allowMultiLogin: false, allowAutomatedRelogin: true},
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
        extension: recovered.extension || options.extension.trim(),
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

  async stationLogin(): Promise<void> {
    if (!this.cc || !this.profile) throw new Error('Initialize Contact Center first.');
    if (!this.snapshot.selectedTeamId) throw new Error('Select an agent team.');
    reportBackendEvent('cc.station_login', 'started');
    try {
      await this.cc.stationLogin({
        teamId: this.snapshot.selectedTeamId,
        loginOption: 'EXTENSION',
        dialNumber: this.snapshot.extension,
      });
      this.setLifecycle('station-logged-in', 'Idle');
      this.log(`Station logged in with extension ${this.snapshot.extension}.`, 'success');
      reportBackendEvent('cc.station_login', 'succeeded');
    } catch (error) {
      reportBackendEvent('cc.station_login', 'failed');
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
    if (!this.snapshot.callId) throw new Error('No Webex Calling call is associated with this task.');
    this.update({callStatus: 'answering', error: ''});
    try {
      await this.api.action('answer', {
        callId: this.snapshot.callId,
        ...(this.snapshot.endpointId ? {endpointId: this.snapshot.endpointId} : {}),
      });
      this.log('Answer sent to the Webex App through Call Controls.', 'success');
      window.setTimeout(() => void this.syncCall(), 350);
    } catch (error) {
      this.update({callStatus: 'ringing'});
      this.fail('Answer failed', error);
    }
  }

  async decline(): Promise<void> {
    if (!this.snapshot.callId || this.snapshot.callStatus !== 'ringing') {
      throw new Error('A ringing Webex Calling call is required.');
    }
    try {
      await this.api.action('hangup', {callId: this.snapshot.callId});
      this.log('Alerting Webex App call declined by ending its Calling leg.', 'success');
      this.clearCallState();
    } catch (error) {
      this.fail('Decline failed', error);
    }
  }

  async toggleMute(): Promise<void> {
    if (!this.snapshot.callId) throw new Error('An active call is required.');
    if (!this.snapshot.muteCapable) throw new Error('This Webex endpoint did not report remote mute support.');
    const action = this.snapshot.muted ? 'unmute' : 'mute';
    try {
      await this.api.action(action, {callId: this.snapshot.callId});
      this.update({muted: !this.snapshot.muted});
      this.log(action === 'mute' ? 'Webex App muted.' : 'Webex App unmuted.', 'success');
    } catch (error) {
      this.fail('Mute control failed', error);
    }
  }

  async sendDigit(digit: string): Promise<void> {
    if (!this.snapshot.callId || this.snapshot.callStatus !== 'connected') {
      throw new Error('DTMF requires a connected call.');
    }
    try {
      await this.api.action('transmitDtmf', {callId: this.snapshot.callId, dtmf: digit});
      this.log(`DTMF ${digit} sent.`);
    } catch (error) {
      this.fail('DTMF failed', error);
    }
  }

  async toggleHold(): Promise<void> {
    if (!this.snapshot.callId) throw new Error('An active call is required.');
    const action = this.snapshot.held ? 'resume' : 'hold';
    try {
      await this.api.action(action, {callId: this.snapshot.callId});
      this.update({held: !this.snapshot.held, callStatus: this.snapshot.held ? 'connected' : 'held'});
      this.log(
        action === 'hold' ? 'Webex App call held.' : 'Webex App call resumed.',
        'success',
      );
    } catch (error) {
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
      await this.task.consultTransfer();
      this.log('Consult transfer completed.', 'success');
      reportBackendEvent('cc.consult_transfer', 'succeeded');
    } catch (error) {
      reportBackendEvent('cc.consult_transfer', 'failed');
      this.fail('Consult transfer failed', error);
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
    if (!this.snapshot.callId) throw new Error('There is no active Webex Calling call.');
    try {
      await this.api.action('hangup', {callId: this.snapshot.callId});
      this.update({
        ...(this.snapshot.callStatus === 'wrap-up' ? {} : {callStatus: 'ended' as const}),
        muted: false,
        held: false,
      });
      this.log('Hangup sent through Call Controls.', 'success');
    } catch (error) {
      this.fail('Hangup failed', error);
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
    this.stopCallPolling();
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
      this.offerGeneration += 1;
      this.update({
        activeTask: task,
        interactionId,
        callStatus: 'ringing',
        callKind: 'locating',
        callerNumber: incomingNumber(task),
        recordingPauseCapable: recordingPauseEnabled(task),
        recordingPaused: false,
        consultActive: false,
        consultDestinationName: '',
        destinations: [],
        destinationsLoaded: false,
        error: '',
      });
      this.log(`WxCC task offered: ${interactionId}. Locating the alerting Webex call.`, 'success');
      reportBackendEvent('cc.task', 'observed', {state: 'ringing'});
      void this.locateCallingCall(task, this.offerGeneration);
    });
    this.cc.on('task:hydrate', (task: ITask) => {
      this.restoreHydratedTask(task);
    });
  }

  private restoreHydratedTask(task: ITask): void {
    this.task = task;
    this.attachTaskListeners(task);
    this.offerGeneration += 1;
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
      callKind: wrapup || terminated ? 'none' : 'locating',
      callerNumber: incomingNumber(task),
      recordingPauseCapable: recordingPauseEnabled(task),
      recordingPaused: recordingPaused(task),
      held: callStatus === 'held',
      consultActive: Boolean(data.isConsulted || data.isConferencing || data.isConferenceInProgress),
      error: '',
    });
    this.log(`WxCC task hydrated after session recovery (${state || 'active'}).`, 'success');
    reportBackendEvent('cc.task', 'observed', {state: callStatus});
    if (!wrapup && !terminated) void this.locateCallingCall(task, this.offerGeneration, true);
  }

  private attachTaskListeners(task: ITask): void {
    if (this.observedTasks.has(task)) return;
    this.observedTasks.add(task);

    task.on('task:established', () => {
      this.update({callStatus: 'connected'});
      this.log('WxCC task established.', 'success');
    });
    task.on('task:hold', () => this.update({held: true, callStatus: 'held'}));
    task.on('task:resume', () => this.update({held: false, callStatus: 'connected'}));
    task.on('task:recordingPaused', () => this.update({recordingPaused: true}));
    task.on('task:recordingResumed', () => this.update({recordingPaused: false}));
    task.on('task:consultCreated', () => this.update({consultActive: true}));
    task.on('task:consulting', () => this.update({consultActive: true}));
    task.on('task:consultEnd', () =>
      this.update({consultActive: false, consultDestinationName: ''}),
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

  private async locateCallingCall(
    task: ITask,
    generation: number,
    recovering = false,
  ): Promise<void> {
    const delays = [0, 250, 500, 1_000, 1_500, 2_000];
    const expectedNumber = incomingNumber(task);
    const offeredAt = Date.now();
    try {
      for (const delay of delays) {
        if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
        if (generation !== this.offerGeneration || this.task !== task) return;
        const calls = await this.api.listCalls();
        const result = recovering
          ? selectRecoverableCall(calls, expectedNumber)
          : selectIncomingCall(calls, expectedNumber, offeredAt);
        if (result.kind === 'matched') {
          this.bindCallingCall(result.call);
          return;
        }
        if (result.kind === 'ambiguous') {
          this.update({callKind: 'ambiguous'});
          this.log(
            `Found ${result.candidates.length} equally plausible active calls; controls remain disabled.`,
            'warning',
          );
          return;
        }
      }
      this.update({callKind: 'none'});
      this.log(
        recovering
          ? 'The Contact Center task was recovered, but no matching active Webex Calling call was found.'
          : 'No alerting Webex Calling call was found before the lookup deadline.',
        'warning',
      );
    } catch (error) {
      this.update({callKind: 'none', error: `Calling lookup failed: ${errorMessage(error)}`});
      this.log(`Calling lookup failed: ${errorMessage(error)}`, 'error');
    }
  }

  private bindCallingCall(call: CallingRestCall): void {
    const id = restCallId(call);
    this.update({
      callId: id,
      callSessionId: call.callSessionId || '',
      callKind: 'wxcc',
      callerName: call.remoteParty?.name || 'Unknown caller',
      callerNumber: call.remoteParty?.number || this.snapshot.callerNumber,
      callStatus: call.state === 'held' ? 'held' : call.state === 'connected' ? 'connected' : 'ringing',
      held: call.state === 'held',
      muted: Boolean(call.muted),
      muteCapable: Boolean(call.muteCapable),
      endpointId: call.endpointId || this.snapshot.endpointId,
    });
    this.log(`Associated WxCC interaction with Calling callId ${id}.`, 'success');
    this.startCallPolling();
  }

  private startCallPolling(): void {
    this.stopCallPolling();
    this.callPollTimer = window.setInterval(() => void this.syncCall(), 1_500);
  }

  private stopCallPolling(): void {
    if (this.callPollTimer) window.clearInterval(this.callPollTimer);
    this.callPollTimer = undefined;
    this.missingCallPolls = 0;
  }

  private async syncCall(): Promise<void> {
    if (!this.snapshot.callId) return;
    try {
      const call = (await this.api.listCalls()).find(
        (candidate) => restCallId(candidate) === this.snapshot.callId,
      );
      if (!call) {
        this.missingCallPolls += 1;
        if (this.missingCallPolls < 2) return;
        this.stopCallPolling();
        this.update({
          ...(this.snapshot.callStatus === 'wrap-up' ? {} : {callStatus: 'ended' as const}),
          muted: false,
          held: false,
        });
        this.log(
          this.snapshot.callStatus === 'wrap-up'
            ? 'Calling call is no longer active; Contact Center wrap-up remains active.'
            : 'Calling call is no longer active; waiting for the Contact Center task state.',
        );
        return;
      }
      this.missingCallPolls = 0;
      const status = this.snapshot.callStatus === 'wrap-up'
        ? 'wrap-up'
        : call.state === 'held'
          ? 'held'
          : call.state === 'connected' || call.state === 'remoteHeld'
            ? 'connected'
            : call.state === 'disconnected'
              ? 'ended'
              : call.state === 'alerting'
                ? 'ringing'
                : this.snapshot.callStatus;
      this.update({
        callStatus: status,
        held: call.state === 'held',
        muted: Boolean(call.muted),
        muteCapable: call.muteCapable ?? this.snapshot.muteCapable,
        endpointId: call.endpointId || this.snapshot.endpointId,
      });
    } catch (error) {
      this.log(`Call-state refresh failed: ${errorMessage(error)}`, 'warning');
    }
  }

  private clearCallState(): void {
    this.stopCallPolling();
    this.offerGeneration += 1;
    this.task = undefined;
    this.update({
      callStatus: 'none',
      interactionId: '',
      callId: '',
      callSessionId: '',
      callKind: 'none',
      callerName: '',
      callerNumber: '',
      muted: false,
      held: false,
      muteCapable: false,
      recordingPaused: false,
      recordingPauseCapable: false,
      consultActive: false,
      consultDestinationName: '',
      destinations: [],
      destinationsLoaded: false,
      activeTask: undefined,
    });
  }
}
