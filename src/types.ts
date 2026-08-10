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

export interface ControllerSnapshot {
  lifecycle: LifecycleStatus;
  callStatus: CallStatus;
  agentName: string;
  agentState: string;
  teams: AgentTeam[];
  selectedTeamId: string;
  extension: string;
  lineStatus: string;
  interactionId: string;
  callId: string;
  callSessionId: string;
  callKind: 'none' | 'wxcc' | 'ambiguous' | 'locating';
  callerName: string;
  callerNumber: string;
  muted: boolean;
  held: boolean;
  muteCapable: boolean;
  recordingPaused: boolean;
  recordingPauseCapable: boolean;
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
  timeline: TimelineEntry[];
  error: string;
  activeTask?: ITask;
}

export interface InitializeOptions {
  accessToken: string;
  extension: string;
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
  teams: [],
  selectedTeamId: '',
  extension: '',
  lineStatus: 'Not checked',
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
  timeline: [],
  error: '',
};
