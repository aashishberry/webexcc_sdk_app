import {type ITask, type Profile} from '@webex/contact-center';
import {reportBackendEvent} from './backendDiagnostics';
import {getAgentPerformance} from './callingApi';
import {normalizeTeams} from './normalizers';
import {recoveredAgentSession} from './sessionRecovery';
import {
  initialSnapshot,
  type ControllerSnapshot,
  type InitializeOptions,
  type LifecycleStatus,
  type LogLevel,
  type AiSuggestion,
  type InteractionContext,
  type InteractionParticipant,
  type StationLoginOption,
  type StationLoginOptions,
  type TranscriptEntry,
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

function firstText(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === 'string' && value.trim() !== '')?.trim() ?? '';
}

function callAssociatedValue(source: unknown, ...keys: string[]): string {
  if (!source || typeof source !== 'object') return '';
  const record = source as Record<string, any>;
  for (const key of keys) {
    const value = record[key]?.value ?? record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function interactionContext(task: ITask): InteractionContext {
  const data = task.data as unknown as Record<string, any>;
  const interaction = data.interaction ?? {};
  const details = interaction.callProcessingDetails ?? data.callProcessingDetails ?? {};
  const associated = interaction.callAssociatedDetails ?? interaction.callAssociatedData ?? {};
  const flow = interaction.callFlowParams ?? data.callFlowParams ?? {};
  return {
    queueName: firstText(
      details.virtualTeamName,
      details.queueName,
      details.QueueName,
      interaction.currentVTeamName,
      interaction.currentVTeam,
    ),
    reason: firstText(
      details.reason,
      details.category,
      callAssociatedValue(associated, 'reason', 'Reason', 'callReason', 'intent'),
      callAssociatedValue(flow, 'reason', 'Reason', 'callReason', 'intent'),
    ),
    ivrPath: firstText(
      details.IvrPath,
      details.ivrPath,
      callAssociatedValue(associated, 'ivrPath', 'IVRPath', 'IvrPath'),
      callAssociatedValue(flow, 'ivrPath', 'IVRPath', 'IvrPath'),
    ),
    entryPoint: firstText(
      details.entryPointName,
      details.EntryPointName,
      details.entryPointId,
      details.EP_ID,
    ),
    language: firstText(
      details.language,
      details.languageCode,
      callAssociatedValue(associated, 'language', 'languageCode', 'Language'),
    ),
    offeredAt: Number(interaction.createdTimestamp || data.createdTimestamp) || undefined,
  };
}

function interactionParticipants(task: ITask, agentId = ''): InteractionParticipant[] {
  const data = task.data as unknown as Record<string, any>;
  const interaction = data.interaction ?? {};
  const media = Object.values(interaction.media ?? {}) as Array<Record<string, any>>;
  return Object.entries(interaction.participants ?? {})
    .map(([id, value]) => {
      const participant = value as Record<string, any>;
      const participantId = firstText(
        participant.id,
        participant.participantId,
        participant.pId,
        id,
      );
      const isHeld = media.some(
        (entry) => entry.isHold === true &&
          Array.isArray(entry.participants) &&
          (entry.participants.includes(id) || entry.participants.includes(participantId)),
      );
      return {
        id: participantId,
        name: firstText(participant.name, participant.pName, participant.dn, participant.callerId) || 'Participant',
        type: firstText(participant.type, participant.pType) || 'Participant',
        state: firstText(participant.consultState, participant.currentState) || (participant.hasJoined ? 'Connected' : 'Invited'),
        held: isHeld,
        isCurrentAgent: participantId === agentId || participant.agentId === agentId,
      };
    })
    .filter((participant) => participant.name || participant.id);
}

function transcriptEntry(payload: any): TranscriptEntry | undefined {
  const data = payload?.data ?? payload;
  const content = firstText(data?.content, data?.text, data?.utterance);
  if (!content) return undefined;
  return {
    id: firstText(data?.messageId, data?.utteranceId) || `${Date.now()}-${content.slice(0, 16)}`,
    role: firstText(data?.role, data?.speaker) || 'UNKNOWN',
    content,
    timestamp: Number(data?.publishTimestamp) || Date.now(),
    isFinal: data?.isFinal !== false,
  };
}

function collectAssistantText(value: unknown, depth = 0): string[] {
  if (depth > 5 || value == null) return [];
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap((entry) => collectAssistantText(entry, depth + 1));
  if (typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const preferred = ['suggestion', 'answer', 'content', 'text', 'response', 'summary'];
  const prioritized = preferred.flatMap((key) => key in record ? collectAssistantText(record[key], depth + 1) : []);
  return prioritized.length
    ? prioritized
    : Object.entries(record)
        .filter(([key]) => !['adaptiveCardId', 'id', 'interactionId', 'conversationId'].includes(key))
        .flatMap(([, entry]) => collectAssistantText(entry, depth + 1));
}

function collectNamedSummaryValues(value: unknown, depth = 0): unknown[] {
  if (depth > 7 || value == null || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectNamedSummaryValues(entry, depth + 1));
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
    /summary|summaries|summarization/i.test(key)
      ? [entry]
      : collectNamedSummaryValues(entry, depth + 1),
  );
}

function summarySectionLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
  return words.replace(/^./, (character) => character.toUpperCase());
}

function collectSummarySections(value: unknown, depth = 0): string[] {
  if (depth > 7 || value == null || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectSummarySections(entry, depth + 1));
  }
  const record = value as Record<string, unknown>;
  if (record.sections && typeof record.sections === 'object' && !Array.isArray(record.sections)) {
    return Object.entries(record.sections as Record<string, unknown>).flatMap(([key, entry]) => {
      const content = collectAssistantText(entry).find((candidate) => candidate.length > 2);
      return content ? [`${summarySectionLabel(key)}: ${content}`] : [];
    });
  }
  return Object.values(record).flatMap((entry) => collectSummarySections(entry, depth + 1));
}

function aiSuggestion(payload: any): AiSuggestion | undefined {
  const data = payload?.data ?? payload;
  const content = collectAssistantText(data).find((value) => value.length > 2) ?? '';
  if (!content) return undefined;
  const adaptiveCardId = firstText(data?.adaptiveCardId, data?.id, payload?.adaptiveCardId);
  return {
    id: adaptiveCardId || `${Date.now()}-${content.slice(0, 16)}`,
    adaptiveCardId,
    content,
    createdAt: Date.now(),
  };
}

function aiSummary(payload: any): string {
  const sections = collectSummarySections(payload);
  if (sections.length) return sections.join('\n\n');
  const namedContent = collectNamedSummaryValues(payload)
    .flatMap((value) => collectAssistantText(value))
    .filter((value, index, all) => value.length > 2 && all.indexOf(value) === index);
  if (namedContent.length) return namedContent.join('\n\n');
  return collectAssistantText(payload).find((value) => value.length > 2) ?? '';
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

function epochMilliseconds(value: unknown): number {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
  return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
}

function taskWrapupStartedAt(task: ITask, agentId = ''): number {
  const data = task.data as unknown as Record<string, any>;
  const participants = Object.entries(data.interaction?.participants ?? {}) as Array<
    [string, Record<string, any>]
  >;
  const currentAgent = participants.find(([id, participant]) =>
    id === agentId ||
    participant.id === agentId ||
    participant.participantId === agentId ||
    participant.agentId === agentId,
  )?.[1];
  return epochMilliseconds(currentAgent?.wrapUpTimestamp);
}

function taskControlState(task: ITask) {
  const main = task.uiControls?.main;
  const activeLeg = task.uiControls?.activeLeg ?? 'main';
  const active = task.uiControls?.[activeLeg] ?? main;
  return {
    acceptCapable: Boolean(main?.accept?.isEnabled),
    declineCapable: Boolean(main?.decline?.isEnabled),
    holdCapable: Boolean(active?.hold?.isEnabled),
    endCapable: Boolean(active?.end?.isEnabled || main?.end?.isEnabled),
    muteCapable: Boolean(active?.mute?.isEnabled),
    dtmfCapable: Boolean(active?.keypad?.isEnabled),
    consultCapable: Boolean(main?.consult?.isEnabled),
    transferCapable: Boolean(main?.transfer?.isEnabled),
    switchCapable: Boolean(active?.switch?.isEnabled),
    conferenceCapable: Boolean(active?.conference?.isEnabled || active?.mergeToConference?.isEnabled),
    consultTransferCapable: Boolean(active?.consultTransfer?.isEnabled),
    endConsultCapable: Boolean(active?.endConsult?.isEnabled),
    exitConferenceCapable: Boolean(active?.exitConference?.isEnabled),
    transferConferenceCapable: Boolean(active?.transferConference?.isEnabled),
    activeLeg,
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

export class WebexController {
  private snapshot: ControllerSnapshot = structuredClone(initialSnapshot);
  private listeners = new Set<SnapshotListener>();
  private webex: any;
  private cc: any;
  private profile?: Profile;
  private task?: ITask;
  private logSequence = 0;
  private observedTasks = new WeakSet<ITask>();
  private applicationTranscriptRequests = new Set<string>();
  private aiAssistanceDelayTimer?: ReturnType<typeof globalThis.setTimeout>;
  private aiSummaryDelayTimer?: ReturnType<typeof globalThis.setTimeout>;
  private performanceRefreshTimer?: ReturnType<typeof globalThis.setTimeout>;
  private rtdWebSocketManager?: {on: (event: string, listener: (payload: unknown) => void) => void; off?: (event: string, listener: (payload: unknown) => void) => void};

  private handleRawAIEvent = (event: unknown): void => {
    try {
      const payload = typeof event === 'string' ? JSON.parse(event) : event;
      const interactionId = firstText(
        payload?.data?.data?.conversationId,
        payload?.data?.data?.interactionId,
        payload?.data?.conversationId,
        payload?.data?.interactionId,
        payload?.eventDetails?.data?.conversationId,
        payload?.eventDetails?.data?.interactionId,
        payload?.conversationId,
        payload?.interactionId,
      );
      if (!interactionId || interactionId !== this.task?.data.interactionId) return;

      const type = firstText(
        payload?.type,
        payload?.eventName,
        payload?.data?.type,
        payload?.data?.eventName,
        payload?.data?.notifType,
        payload?.data?.notifDetails?.actionEvent,
        payload?.data?.data?.type,
        payload?.data?.data?.eventName,
        payload?.eventDetails?.type,
        payload?.eventDetails?.eventName,
        payload?.eventDetails?.data?.type,
        payload?.eventDetails?.data?.eventName,
      );
      if (type === 'SUGGESTED_RESPONSE_ACKNOWLEDGE') {
        this.update({
          aiAssistanceStatus: 'accepted',
          aiAssistanceMessage: 'AI Assist acknowledged the request and is preparing a suggestion.',
        });
        return;
      }

      if (type === 'MID_CALL_SUMMARY' || type === 'MID_CALL_SUMMARY_RESPONSE') {
        this.receiveSummary('mid-call', payload);
      } else if (type === 'POST_CALL_SUMMARY' || type === 'POST_CALL_SUMMARY_RESPONSE') {
        this.receiveSummary('post-call', payload);
      }
    } catch {
      // The SDK owns parsing and diagnostics for unrelated RTD messages.
    }
  };

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
    this.update({
      lifecycle,
      ...(agentState
        ? {agentState, ...(agentState !== this.snapshot.agentState ? {stateChangedAt: Date.now()} : {})}
        : {}),
    });
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
      this.attachRawAIEvents();
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
        realtimeTranscriptionEnabled: profile.aiFeature?.realtimeTranscripts?.enable === true,
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
      void this.loadPerformance();
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

  async loadPerformance(): Promise<void> {
    if (!this.webex || !this.profile?.agentId) {
      this.update({
        performanceStatus: 'unavailable',
        performanceMessage: 'Initialize Contact Center before loading performance statistics.',
      });
      return;
    }

    let apiBaseUrl = '';
    try {
      apiBaseUrl = this.webex.internal?.services?.get?.('wcc-api-gateway') || '';
    } catch {
      apiBaseUrl = '';
    }
    if (!apiBaseUrl) {
      this.update({
        performanceStatus: 'unavailable',
        performanceMessage: 'The regional Contact Center reporting service was not discovered.',
      });
      return;
    }

    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const to = now.getTime();
    this.update({performanceStatus: 'loading', performanceMessage: ''});
    try {
      const result = await getAgentPerformance({
        apiBaseUrl,
        agentId: this.profile.agentId,
        from,
        to,
      });
      if (!result.available) {
        this.update({
          performance: undefined,
          performanceStatus: 'unavailable',
          performanceMessage: result.message,
        });
        this.log('Contact Center reporting is unavailable for this user.', 'warning');
        return;
      }
      this.update({
        performance: result.performance,
        performanceStatus: 'ready',
        performanceMessage: '',
      });
      this.log('Today’s agent performance statistics loaded.', 'success');
    } catch {
      this.update({
        performanceStatus: 'error',
        performanceMessage: 'Performance statistics could not be loaded. Retry to check again.',
      });
      this.log('Agent performance statistics request failed.', 'warning');
    }
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

  async startTranscription(): Promise<void> {
    if (!this.cc?.apiAIAssistant || !this.task || !this.profile) {
      throw new Error('A connected Contact Center interaction is required to start transcription.');
    }
    if (!this.snapshot.realtimeTranscriptionEnabled) {
      this.update({
        transcriptionStatus: 'unavailable',
        transcriptionMessage: 'Real-time transcription is not enabled in this agent profile.',
      });
      throw new Error('Real-time transcription is not enabled in this agent profile.');
    }

    const interactionId = this.task.data.interactionId;
    if (this.applicationTranscriptRequests.has(interactionId)) return;
    this.applicationTranscriptRequests.add(interactionId);
    this.update({transcriptionStatus: 'starting', transcriptionMessage: ''});
    reportBackendEvent('cc.ai_transcript', 'started', {action: 'start'});
    try {
      await this.cc.apiAIAssistant.sendEvent(
        this.profile.agentId,
        interactionId,
        'CUSTOM_EVENT',
        'GET_TRANSCRIPTS',
        {action: 'START'},
        'en',
      );
      if (
        this.task?.data.interactionId === interactionId &&
        this.applicationTranscriptRequests.has(interactionId)
      ) {
        this.update({
          transcriptionStatus: 'requested',
          transcriptionMessage: 'Transcript streaming was requested. Waiting for the first utterance.',
        });
      }
      this.log('Real-time transcript streaming requested.', 'success');
      reportBackendEvent('cc.ai_transcript', 'succeeded', {action: 'start'});
    } catch (error) {
      this.applicationTranscriptRequests.delete(interactionId);
      if (this.task?.data.interactionId === interactionId) {
        this.update({
          transcriptionStatus: 'error',
          transcriptionMessage: `Transcript streaming could not be started: ${errorMessage(error)}`,
        });
      }
      this.log('Real-time transcript streaming request failed.', 'warning');
      reportBackendEvent('cc.ai_transcript', 'failed', {action: 'start'});
      throw error;
    }
  }

  async requestAssistance(context = ''): Promise<void> {
    if (!this.cc?.apiAIAssistant || !this.task || !this.profile) {
      throw new Error('AI assistance is not available for the active interaction.');
    }
    this.clearAIResponseTimer('assist');
    this.update({
      aiAssistanceLoading: true,
      aiAssistanceStatus: 'requesting',
      aiAssistanceMessage: 'Sending the assistance request…',
      aiError: '',
    });
    try {
      const response = await this.cc.apiAIAssistant.getRealTimeAssistance({
        agentId: this.profile.agentId,
        interactionId: this.task.data.interactionId,
        languageCode: 'en',
        ...(context.trim() ? {context: context.trim()} : {}),
      });
      const suggestion = aiSuggestion(response);
      if (suggestion) {
        this.update({
          aiSuggestions: [
            suggestion,
            ...this.snapshot.aiSuggestions.filter((item) => item.id !== suggestion.id),
          ].slice(0, 10),
          aiAssistanceStatus: 'received',
          aiAssistanceMessage: 'A new AI suggestion was received.',
        });
      } else {
        this.update({
          aiAssistanceStatus: 'accepted',
          aiAssistanceMessage: 'Request accepted. Waiting for the suggested-response event.',
        });
        this.scheduleAIResponseWarning('assist');
      }
      this.log('AI assistance requested.');
      reportBackendEvent('cc.ai_assistance', 'succeeded');
    } catch (error) {
      const message = errorMessage(error);
      this.update({
        aiAssistanceStatus: 'error',
        aiAssistanceMessage: 'AI Assist could not accept the request.',
        aiError: message,
      });
      reportBackendEvent('cc.ai_assistance', 'failed');
      this.fail('AI assistance request failed', error);
    } finally {
      this.update({aiAssistanceLoading: false});
    }
  }

  async sendAssistanceFeedback(
    suggestionId: string,
    actionId: 'likeButton' | 'dislikeButton' | 'copyButton',
  ): Promise<void> {
    if (!this.cc?.apiAIAssistant || !this.task || !this.profile) return;
    const suggestion = this.snapshot.aiSuggestions.find((item) => item.id === suggestionId);
    if (!suggestion?.adaptiveCardId) return;
    try {
      await this.cc.apiAIAssistant.sendRealTimeAssistanceUserAction({
        agentId: this.profile.agentId,
        interactionId: this.task.data.interactionId,
        adaptiveCardId: suggestion.adaptiveCardId,
        actionId,
      });
      reportBackendEvent('cc.ai_feedback', 'succeeded', {action: actionId});
    } catch (error) {
      reportBackendEvent('cc.ai_feedback', 'failed', {action: actionId});
      this.fail('AI feedback failed', error);
    }
  }

  async requestSummary(kind: 'mid-call' | 'post-call'): Promise<void> {
    if (!this.cc?.apiAIAssistant || !this.task || !this.profile) {
      throw new Error('AI summaries are not available for the active interaction.');
    }
    this.clearAIResponseTimer('summary');
    this.update({
      aiSummaryLoading: true,
      aiSummaryStatus: 'requesting',
      aiSummaryMessage: `Requesting a ${kind === 'mid-call' ? 'mid-call' : 'post-call'} summary…`,
      aiError: '',
    });
    try {
      const response = await this.cc.apiAIAssistant.sendEvent(
        this.profile.agentId,
        this.task.data.interactionId,
        'CUSTOM_EVENT',
        kind === 'mid-call'
          ? 'GET_MID_CALL_SUMMARY'
          : 'GET_POST_CALL_SUMMARY',
        {},
        'en',
      );
      const summary = aiSummary(response);
      if (summary) {
        this.receiveSummary(kind, response);
      } else {
        this.update({
          aiSummaryLoading: false,
          aiSummaryStatus: 'accepted',
          aiSummaryMessage: 'Request accepted. Waiting for the summary response event.',
        });
        this.scheduleAIResponseWarning('summary');
      }
      this.log(`${kind === 'mid-call' ? 'Mid-call' : 'Post-call'} AI summary requested.`);
      reportBackendEvent('cc.ai_summary', 'succeeded', {action: kind});
    } catch (error) {
      const message = errorMessage(error);
      this.update({
        aiSummaryLoading: false,
        aiSummaryStatus: 'error',
        aiSummaryMessage: 'The summary request failed.',
        aiError: message,
      });
      reportBackendEvent('cc.ai_summary', 'failed', {action: kind});
      this.fail('AI summary request failed', error);
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

  async switchCall(): Promise<void> {
    if (!this.task || !this.snapshot.switchCapable) {
      throw new Error('Switching call legs is not available.');
    }
    try {
      await this.task.switchCall();
      this.update(taskControlState(this.task));
      this.log('Active call leg switched.', 'success');
      reportBackendEvent('cc.consult_switch', 'succeeded');
    } catch (error) {
      reportBackendEvent('cc.consult_switch', 'failed');
      this.fail('Switching call legs failed', error);
    }
  }

  async dropConferenceParticipant(participantId: string): Promise<void> {
    if (!this.task || !this.snapshot.conferenceActive) throw new Error('No active conference.');
    if (!participantId) throw new Error('Select a conference participant.');
    try {
      await this.task.dropConferenceParticipant({participantId});
      this.update({participants: interactionParticipants(this.task, this.profile?.agentId)});
      this.log('Conference participant dropped.', 'success');
      reportBackendEvent('cc.conference_participant', 'succeeded', {action: 'drop'});
    } catch (error) {
      reportBackendEvent('cc.conference_participant', 'failed', {action: 'drop'});
      this.fail('Dropping conference participant failed', error);
    }
  }

  async transferConference(): Promise<void> {
    if (!this.task || !this.snapshot.transferConferenceCapable) {
      throw new Error('Conference handover is not available.');
    }
    try {
      await this.task.transferConference();
      this.log('Conference handed over.', 'success');
      reportBackendEvent('cc.conference', 'succeeded', {action: 'transfer'});
    } catch (error) {
      reportBackendEvent('cc.conference', 'failed', {action: 'transfer'});
      this.fail('Conference handover failed', error);
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
    const task = this.task;
    const code = this.profile?.wrapupCodes.find(
      (candidate) => candidate.id === this.snapshot.selectedWrapupCode,
    );
    if (!code) throw new Error('Select a wrap-up code.');
    try {
      await task.wrapup({wrapUpReason: code.name, auxCodeId: code.id});
      this.stopTranscription(task);
      this.log(`Wrap-up submitted: ${code.name}.`, 'success');
      reportBackendEvent('cc.wrapup', 'succeeded');
      this.clearCallState();
      this.schedulePerformanceRefresh();
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
      this.detachRawAIEvents();
      this.cc = undefined;
      this.profile = undefined;
      this.task = undefined;
      this.applicationTranscriptRequests.clear();
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
      this.update({
        agentState: state,
        lifecycle,
        ...(state !== this.snapshot.agentState ? {stateChangedAt: Date.now()} : {}),
        ...(idleCode ? {selectedIdleCode: idleCode.id} : {}),
      });
      this.log(`WxCC agent state event: ${state}.`);
    });
    this.cc.on('task:incoming', (task: ITask) => {
      this.task = task;
      this.attachTaskListeners(task);
      const interactionId = task.data.interactionId;
      this.update({
        activeTask: task,
        interactionId,
        callStartedAt: interactionContext(task).offeredAt || Date.now(),
        callEndedAt: 0,
        wrapupStartedAt: 0,
        callStatus: 'ringing',
        callerName: incomingName(task),
        callerNumber: incomingNumber(task),
        interactionContext: interactionContext(task),
        participants: interactionParticipants(task, this.profile?.agentId),
        ...taskControlState(task),
        muted: task.getWxAppMuted?.() ?? false,
        recordingPauseCapable: recordingPauseEnabled(task),
        recordingPaused: false,
        consultActive: false,
        conferenceActive: false,
        consultDestinationName: '',
        destinations: [],
        destinationsLoaded: false,
        transcripts: [],
        transcriptionStatus: this.snapshot.realtimeTranscriptionEnabled ? 'waiting' : 'unavailable',
        transcriptionMessage: this.snapshot.realtimeTranscriptionEnabled
          ? 'Transcript streaming will start when the interaction connects.'
          : 'Real-time transcription is not enabled in this agent profile.',
        aiSuggestions: [],
        aiAssistanceLoading: false,
        aiAssistanceStatus: 'idle',
        aiAssistanceMessage: '',
        aiSummaryLoading: false,
        aiSummaryStatus: 'idle',
        aiSummaryMessage: '',
        aiError: '',
        midCallSummary: '',
        postCallSummary: '',
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
    const wrapupStartedAt = wrapup ? taskWrapupStartedAt(task, this.profile?.agentId) || Date.now() : 0;

    this.update({
      activeTask: task,
      interactionId: task.data.interactionId,
      callStartedAt: interactionContext(task).offeredAt || Date.now(),
      callEndedAt: terminated ? wrapupStartedAt || Date.now() : 0,
      wrapupStartedAt,
      callStatus,
      callerName: incomingName(task),
      callerNumber: incomingNumber(task),
      interactionContext: interactionContext(task),
      participants: interactionParticipants(task, this.profile?.agentId),
      ...taskControlState(task),
      muted: task.getWxAppMuted?.() ?? false,
      recordingPauseCapable: recordingPauseEnabled(task),
      recordingPaused: recordingPaused(task),
      held: callStatus === 'held',
      consultActive: Boolean(data.isConsulted) && !(data.isConferencing || data.isConferenceInProgress),
      conferenceActive: Boolean(data.isConferencing || data.isConferenceInProgress),
      transcriptionStatus: terminated
        ? 'stopped'
        : this.snapshot.realtimeTranscriptionEnabled
          ? 'waiting'
          : 'unavailable',
      transcriptionMessage: this.snapshot.realtimeTranscriptionEnabled
        ? ''
        : 'Real-time transcription is not enabled in this agent profile.',
      remoteAudioTrack: undefined,
      error: '',
    });
    this.log(`WxCC task hydrated after session recovery (${state || 'active'}).`, 'success');
    reportBackendEvent('cc.task', 'observed', {state: callStatus});
    void this.restoreHistoricTranscripts(task);
    if (callStatus === 'connected' || callStatus === 'held') {
      void this.startTranscription().catch(() => undefined);
    }
  }

  private attachTaskListeners(task: ITask): void {
    if (this.observedTasks.has(task)) return;
    this.observedTasks.add(task);

    task.on('task:ui-controls-updated', () => {
      if (this.task === task) {
        this.update({
          ...taskControlState(task),
          interactionContext: interactionContext(task),
          participants: interactionParticipants(task, this.profile?.agentId),
        });
      }
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

    task.on('task:assigned', () => {
      if (this.task !== task) return;
      this.update({callStatus: 'connected', ...taskControlState(task)});
      this.log('WxCC task assigned and connected.', 'success');
      void this.startTranscription().catch(() => undefined);
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
    task.on('REAL_TIME_TRANSCRIPTION', (payload: unknown) => {
      if (this.task !== task) return;
      const entry = transcriptEntry(payload);
      if (!entry) return;
      const transcripts = [...this.snapshot.transcripts];
      const existingIndex = transcripts.findIndex((candidate) => candidate.id === entry.id);
      if (existingIndex >= 0) transcripts[existingIndex] = entry;
      else transcripts.push(entry);
      this.update({
        transcripts: transcripts.slice(-200),
        transcriptionStatus: 'active',
        transcriptionMessage: '',
      });
    });
    task.on('SUGGESTED_RESPONSE', (payload: unknown) => {
      if (this.task !== task) return;
      const suggestion = aiSuggestion(payload);
      if (!suggestion) return;
      this.update({
        aiSuggestions: [suggestion, ...this.snapshot.aiSuggestions.filter((item) => item.id !== suggestion.id)].slice(0, 10),
        aiAssistanceLoading: false,
        aiAssistanceStatus: 'received',
        aiAssistanceMessage: 'A new AI suggestion was received.',
        aiError: '',
      });
      this.clearAIResponseTimer('assist');
      this.log('AI suggested response received.', 'success');
    });
    task.on('MID_CALL_SUMMARY', (payload: unknown) => {
      if (this.task !== task) return;
      this.receiveSummary('mid-call', payload);
    });
    task.on('POST_CALL_SUMMARY', (payload: unknown) => {
      if (this.task !== task) return;
      this.receiveSummary('post-call', payload);
    });
    task.on('task:wrapup', () => {
      const startedAt = taskWrapupStartedAt(task, this.profile?.agentId) || Date.now();
      this.stopTranscription(task);
      this.update({
        callStatus: 'wrap-up',
        callEndedAt: this.snapshot.callEndedAt || startedAt,
        wrapupStartedAt: this.snapshot.wrapupStartedAt || startedAt,
      });
      this.log('WxCC task entered wrap-up.');
    });
    task.on('task:wrappedup', () => {
      this.stopTranscription(task);
      this.log('WxCC task wrap-up completed.', 'success');
      this.clearCallState();
      this.schedulePerformanceRefresh();
    });
    task.on('task:end', (endedTask?: ITask) => {
      const currentTask = endedTask ?? task;
      this.task = currentTask;
      const endedAt = taskWrapupStartedAt(currentTask, this.profile?.agentId) || Date.now();
      this.stopTranscription(currentTask);

      if (currentTask.data.wrapUpRequired) {
        this.update({
          activeTask: currentTask,
          callStatus: 'wrap-up',
          callEndedAt: this.snapshot.callEndedAt || endedAt,
          wrapupStartedAt: this.snapshot.wrapupStartedAt || endedAt,
        });
        this.log('WxCC task ended; waiting for wrap-up.');
        void this.requestSummary('post-call').catch(() => undefined);
        return;
      }

      this.log('WxCC task ended; no wrap-up is required.', 'success');
      this.clearCallState();
      this.schedulePerformanceRefresh();
    });
    task.on('task:error', (error: unknown) =>
      this.log(`WxCC task error: ${errorMessage(error)}`, 'error'),
    );
  }

  private async restoreHistoricTranscripts(task: ITask): Promise<void> {
    if (!this.cc?.apiAIAssistant || !this.profile) return;
    try {
      const response = await this.cc.apiAIAssistant.fetchHistoricTranscripts(
        this.profile.agentId,
        task.data.interactionId,
      );
      if (this.task !== task || !Array.isArray(response?.data)) return;
      const transcripts = response.data
        .filter((entry: any) => typeof entry?.content === 'string' && entry.content.trim())
        .map((entry: any): TranscriptEntry => ({
          id: firstText(entry.messageId) || `${entry.publishTimestamp}-${entry.content.slice(0, 16)}`,
          role: firstText(entry.role) || 'UNKNOWN',
          content: entry.content.trim(),
          timestamp: Number(entry.publishTimestamp) || Date.now(),
          isFinal: true,
        }));
      this.update({transcripts: transcripts.slice(-200)});
      this.log(`Restored ${transcripts.length} transcript entries.`);
    } catch {
      this.log('Historic transcript recovery is unavailable for this interaction.', 'warning');
    }
  }

  private stopTranscription(task: ITask): void {
    const interactionId = task.data.interactionId;
    if (!this.applicationTranscriptRequests.delete(interactionId)) return;
    if (!this.cc?.apiAIAssistant || !this.profile) return;

    reportBackendEvent('cc.ai_transcript', 'started', {action: 'stop'});
    void this.cc.apiAIAssistant
      .sendEvent(
        this.profile.agentId,
        interactionId,
        'CUSTOM_EVENT',
        'GET_TRANSCRIPTS',
        {action: 'STOP'},
        'en',
      )
      .then(() => {
        if (this.task?.data.interactionId === interactionId) {
          this.update({transcriptionStatus: 'stopped', transcriptionMessage: ''});
        }
        this.log('Real-time transcript streaming stopped.');
        reportBackendEvent('cc.ai_transcript', 'succeeded', {action: 'stop'});
      })
      .catch(() => {
        this.log('Real-time transcript stop request failed.', 'warning');
        reportBackendEvent('cc.ai_transcript', 'failed', {action: 'stop'});
      });
  }

  private attachRawAIEvents(): void {
    const manager = this.cc?.services?.rtdWebSocketManager as typeof this.rtdWebSocketManager;
    if (!manager || manager === this.rtdWebSocketManager) return;
    this.detachRawAIEvents();
    this.rtdWebSocketManager = manager;
    manager.on('message', this.handleRawAIEvent);
  }

  private detachRawAIEvents(): void {
    this.rtdWebSocketManager?.off?.('message', this.handleRawAIEvent);
    this.rtdWebSocketManager = undefined;
  }

  private clearAIResponseTimer(kind: 'assist' | 'summary'): void {
    const timer = kind === 'assist' ? this.aiAssistanceDelayTimer : this.aiSummaryDelayTimer;
    if (timer) globalThis.clearTimeout(timer);
    if (kind === 'assist') this.aiAssistanceDelayTimer = undefined;
    else this.aiSummaryDelayTimer = undefined;
  }

  private scheduleAIResponseWarning(kind: 'assist' | 'summary'): void {
    this.clearAIResponseTimer(kind);
    const timer = globalThis.setTimeout(() => {
      if (kind === 'assist' && this.snapshot.aiAssistanceStatus === 'accepted') {
        this.update({
          aiAssistanceStatus: 'delayed',
          aiAssistanceMessage: 'The request was accepted, but no suggested-response event has arrived yet. You can retry.',
        });
      }
      if (kind === 'summary' && this.snapshot.aiSummaryStatus === 'accepted') {
        this.update({
          aiSummaryStatus: 'delayed',
          aiSummaryMessage: 'The request was accepted, but no summary response event has arrived yet. You can retry.',
        });
      }
    }, 20_000);
    if (kind === 'assist') this.aiAssistanceDelayTimer = timer;
    else this.aiSummaryDelayTimer = timer;
  }

  private receiveSummary(kind: 'mid-call' | 'post-call', payload: unknown): void {
    const summary = aiSummary(payload);
    if (!summary) return;
    this.clearAIResponseTimer('summary');
    this.update({
      aiSummaryLoading: false,
      aiSummaryStatus: 'received',
      aiSummaryMessage: `${kind === 'mid-call' ? 'Mid-call' : 'Post-call'} summary received.`,
      aiError: '',
      ...(kind === 'mid-call' ? {midCallSummary: summary} : {postCallSummary: summary}),
    });
    this.log(`${kind === 'mid-call' ? 'Mid-call' : 'Post-call'} AI summary received.`, 'success');
  }

  private schedulePerformanceRefresh(): void {
    if (!this.webex || !this.profile?.agentId) return;
    if (this.performanceRefreshTimer) globalThis.clearTimeout(this.performanceRefreshTimer);
    this.performanceRefreshTimer = globalThis.setTimeout(() => {
      this.performanceRefreshTimer = undefined;
      void this.loadPerformance();
    }, 2_000);
  }

  private clearCallState(): void {
    this.clearAIResponseTimer('assist');
    this.clearAIResponseTimer('summary');
    this.task = undefined;
    this.update({
      callStatus: 'none',
      interactionId: '',
      callStartedAt: 0,
      callEndedAt: 0,
      wrapupStartedAt: 0,
      callerName: '',
      callerNumber: '',
      interactionContext: structuredClone(initialSnapshot.interactionContext),
      participants: [],
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
      consultCapable: false,
      transferCapable: false,
      switchCapable: false,
      conferenceCapable: false,
      consultTransferCapable: false,
      endConsultCapable: false,
      exitConferenceCapable: false,
      transferConferenceCapable: false,
      activeLeg: 'main',
      consultActive: false,
      conferenceActive: false,
      consultDestinationName: '',
      destinations: [],
      destinationsLoaded: false,
      transcripts: [],
      transcriptionStatus: 'idle',
      transcriptionMessage: '',
      aiSuggestions: [],
      aiAssistanceLoading: false,
      aiAssistanceStatus: 'idle',
      aiAssistanceMessage: '',
      aiSummaryLoading: false,
      aiSummaryStatus: 'idle',
      aiSummaryMessage: '',
      aiError: '',
      midCallSummary: '',
      postCallSummary: '',
      activeTask: undefined,
      remoteAudioTrack: undefined,
    });
  }
}
