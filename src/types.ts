import type {Profile, ITask} from '@webex/contact-center';

export type LifecycleStatus =
  | 'signed-out'
  | 'initializing'
  | 'initialized'
  | 'station-logged-in'
  | 'available'
  | 'idle'
  | 'logging-out'
  | 'error';

export type CallStatus =
  | 'none'
  | 'ringing'
  | 'answering'
  | 'connected'
  | 'held'
  | 'wrap-up'
  | 'ended';

export type LogLevel = 'info' | 'success' | 'warning' | 'error';

export type StationLoginOption = 'BROWSER' | 'EXTENSION' | 'AGENT_DN';

export interface TimelineEntry {
  id: number;
  at: string;
  level: LogLevel;
  message: string;
}

export interface AgentTeam {
  id: string;
  name: string;
}

export interface CallDestination {
  id: string;
  name: string;
  type: 'agent' | 'queue';
  detail?: string;
}

export interface InteractionContext {
  queueName: string;
  reason: string;
  ivrPath: string;
  entryPoint: string;
  language: string;
  offeredAt?: number;
}

export interface InteractionParticipant {
  id: string;
  name: string;
  type: string;
  state: string;
  held: boolean;
  isCurrentAgent: boolean;
}

export interface TranscriptEntry {
  id: string;
  role: string;
  content: string;
  timestamp: number;
  isFinal: boolean;
}

export interface AiSuggestion {
  id: string;
  adaptiveCardId: string;
  content: string;
  createdAt: number;
}

export interface AgentPerformanceSummary {
  source: 'graphql-search';
  scope: 'agent';
  from: number;
  to: number;
  handled: number;
  averageConnectedSeconds: number;
  averageHoldSeconds: number;
  averageWrapupSeconds: number;
}

export type PerformanceStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';

export type TranscriptionStatus =
  | 'idle'
  | 'waiting'
  | 'starting'
  | 'requested'
  | 'active'
  | 'stopped'
  | 'unavailable'
  | 'error';

export type AIRequestStatus =
  | 'idle'
  | 'requesting'
  | 'accepted'
  | 'received'
  | 'delayed'
  | 'error';

export interface ControllerSnapshot {
  lifecycle: LifecycleStatus;
  callStatus: CallStatus;
  agentName: string;
  agentState: string;
  stateChangedAt: number;
  teams: AgentTeam[];
  selectedTeamId: string;
  stationLoginOption: StationLoginOption | '';
  stationDialNumber: string;
  loginVoiceOptions: StationLoginOption[];
  webRtcEnabled: boolean;
  lineStatus: string;
  interactionId: string;
  callStartedAt: number;
  callEndedAt: number;
  wrapupStartedAt: number;
  callerName: string;
  callerNumber: string;
  interactionContext: InteractionContext;
  participants: InteractionParticipant[];
  acceptCapable: boolean;
  declineCapable: boolean;
  holdCapable: boolean;
  endCapable: boolean;
  muted: boolean;
  held: boolean;
  muteCapable: boolean;
  dtmfCapable: boolean;
  recordingPaused: boolean;
  recordingPauseCapable: boolean;
  consultCapable: boolean;
  transferCapable: boolean;
  switchCapable: boolean;
  conferenceCapable: boolean;
  consultTransferCapable: boolean;
  endConsultCapable: boolean;
  exitConferenceCapable: boolean;
  transferConferenceCapable: boolean;
  activeLeg: 'main' | 'consult';
  consultActive: boolean;
  conferenceActive: boolean;
  consultDestinationName: string;
  destinations: CallDestination[];
  destinationsLoaded: boolean;
  endpointId: string;
  endpointName: string;
  wrapupCodes: Profile['wrapupCodes'];
  selectedWrapupCode: string;
  idleCodes: Profile['idleCodes'];
  selectedIdleCode: string;
  transcripts: TranscriptEntry[];
  realtimeTranscriptionEnabled: boolean;
  transcriptionStatus: TranscriptionStatus;
  transcriptionMessage: string;
  aiSuggestions: AiSuggestion[];
  aiAssistanceLoading: boolean;
  aiAssistanceStatus: AIRequestStatus;
  aiAssistanceMessage: string;
  aiSummaryLoading: boolean;
  aiSummaryStatus: AIRequestStatus;
  aiSummaryMessage: string;
  aiError: string;
  midCallSummary: string;
  postCallSummary: string;
  performance?: AgentPerformanceSummary;
  performanceStatus: PerformanceStatus;
  performanceMessage: string;
  timeline: TimelineEntry[];
  error: string;
  activeTask?: ITask;
  remoteAudioTrack?: MediaStreamTrack;
}

export interface InitializeOptions {
  accessToken: string;
}

export interface StationLoginOptions {
  loginOption: StationLoginOption;
  dialNumber?: string;
  answerEndpoint?: {
    id: string;
    name: string;
    type?: string;
    status?: string;
  };
}

export const initialSnapshot: ControllerSnapshot = {
  lifecycle: 'signed-out',
  callStatus: 'none',
  agentName: '',
  agentState: 'Signed out',
  stateChangedAt: 0,
  teams: [],
  selectedTeamId: '',
  stationLoginOption: '',
  stationDialNumber: '',
  loginVoiceOptions: [],
  webRtcEnabled: false,
  lineStatus: 'Not checked',
  interactionId: '',
  callStartedAt: 0,
  callEndedAt: 0,
  wrapupStartedAt: 0,
  callerName: '',
  callerNumber: '',
  interactionContext: {
    queueName: '',
    reason: '',
    ivrPath: '',
    entryPoint: '',
    language: '',
  },
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
  endpointId: '',
  endpointName: '',
  wrapupCodes: [],
  selectedWrapupCode: '',
  idleCodes: [],
  selectedIdleCode: '',
  transcripts: [],
  realtimeTranscriptionEnabled: false,
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
  performanceStatus: 'idle',
  performanceMessage: '',
  timeline: [],
  error: '',
};
