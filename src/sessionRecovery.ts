import type {Profile} from '@webex/contact-center';
import type {InitializeOptions, LifecycleStatus} from './types';

const STORAGE_KEY = 'webex-agent-console:recovery:v1';

export interface RecoveryIntent {
  version: 1;
  extension: string;
  answerEndpoint?: InitializeOptions['answerEndpoint'];
}

export interface RecoveredAgentSession {
  loggedIn: boolean;
  lifecycle: LifecycleStatus;
  agentState: string;
  teamId: string;
  extension: string;
  idleCodeId: string;
  deviceType: string;
}

export function readRecoveryIntent(): RecoveryIntent | undefined {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<RecoveryIntent>;
    if (value.version !== 1 || typeof value.extension !== 'string' || !value.extension.trim()) {
      return undefined;
    }
    return {
      version: 1,
      extension: value.extension.trim(),
      ...(value.answerEndpoint?.id ? {answerEndpoint: value.answerEndpoint} : {}),
    };
  } catch {
    return undefined;
  }
}

export function saveRecoveryIntent(options: InitializeOptions): void {
  try {
    const intent: RecoveryIntent = {
      version: 1,
      extension: options.extension.trim(),
      ...(options.answerEndpoint?.id ? {answerEndpoint: options.answerEndpoint} : {}),
    };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(intent));
  } catch {
    // Recovery is an enhancement; storage restrictions must not block station login.
  }
}

export function clearRecoveryIntent(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // The explicit backend/OAuth logout remains authoritative.
  }
}

export function recoveredAgentSession(profile: Profile): RecoveredAgentSession {
  const loggedIn = profile.isAgentLoggedIn === true;
  const auxCodeId = profile.lastStateAuxCodeId || '';
  const idleCode = profile.idleCodes.find((code) => code.id === auxCodeId);
  const available = loggedIn && auxCodeId === '0';

  return {
    loggedIn,
    lifecycle: loggedIn ? (available ? 'available' : 'idle') : 'initialized',
    agentState: loggedIn ? (available ? 'Available' : idleCode?.name || 'Idle') : 'Ready for station login',
    teamId: profile.currentTeamId || '',
    extension: profile.dn || profile.defaultDn || '',
    idleCodeId: idleCode && !idleCode.isSystem ? idleCode.id : '',
    deviceType: profile.deviceType || '',
  };
}
