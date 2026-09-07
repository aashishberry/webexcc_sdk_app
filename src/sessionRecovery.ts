import type {Profile} from '@webex/contact-center';
import type {LifecycleStatus, StationLoginOption, StationLoginOptions} from './types';

const STORAGE_KEY = 'webex-agent-console:recovery:v2';
const LEGACY_STORAGE_KEY = 'webex-agent-console:recovery:v1';

export interface RecoveryIntent {
  version: 2;
  loginOption: StationLoginOption;
  dialNumber: string;
  answerEndpoint?: StationLoginOptions['answerEndpoint'];
}

interface RecoveredAgentSession {
  loggedIn: boolean;
  lifecycle: LifecycleStatus;
  agentState: string;
  teamId: string;
  dialNumber: string;
  idleCodeId: string;
  deviceType: StationLoginOption | '';
}

function isLoginOption(value: unknown): value is StationLoginOption {
  return value === 'BROWSER' || value === 'EXTENSION' || value === 'AGENT_DN';
}

export function readRecoveryIntent(): RecoveryIntent | undefined {
  try {
    const raw =
      window.sessionStorage.getItem(STORAGE_KEY) ??
      window.sessionStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as {
      version?: number;
      loginOption?: unknown;
      dialNumber?: unknown;
      extension?: string;
      answerEndpoint?: StationLoginOptions['answerEndpoint'];
    };
    if (value.version === 1 && typeof value.extension === 'string') {
      return {
        version: 2,
        loginOption: 'EXTENSION',
        dialNumber: value.extension.trim(),
        ...(value.answerEndpoint?.id ? {answerEndpoint: value.answerEndpoint} : {}),
      };
    }
    if (value.version !== 2 || !isLoginOption(value.loginOption)) return undefined;
    return {
      version: 2,
      loginOption: value.loginOption,
      dialNumber: typeof value.dialNumber === 'string' ? value.dialNumber.trim() : '',
      ...(value.answerEndpoint?.id ? {answerEndpoint: value.answerEndpoint} : {}),
    };
  } catch {
    return undefined;
  }
}

export function saveRecoveryIntent(options: StationLoginOptions): void {
  try {
    const intent: RecoveryIntent = {
      version: 2,
      loginOption: options.loginOption,
      dialNumber: options.dialNumber?.trim() ?? '',
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
    window.sessionStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // The explicit backend/OAuth logout remains authoritative.
  }
}

export function recoveredAgentSession(profile: Profile): RecoveredAgentSession {
  const loggedIn = profile.isAgentLoggedIn === true;
  const auxCodeId = profile.lastStateAuxCodeId || '';
  const idleCode = profile.idleCodes.find((code) => code.id === auxCodeId);
  const available = loggedIn && auxCodeId === '0';

  const deviceType = isLoginOption(profile.deviceType) ? profile.deviceType : '';

  return {
    loggedIn,
    lifecycle: loggedIn ? (available ? 'available' : 'idle') : 'initialized',
    agentState: loggedIn ? (available ? 'Available' : idleCode?.name || 'Idle') : 'Ready for station login',
    teamId: profile.currentTeamId || '',
    dialNumber: deviceType === 'BROWSER' ? '' : profile.dn || profile.defaultDn || '',
    idleCodeId: idleCode && !idleCode.isSystem ? idleCode.id : '',
    deviceType,
  };
}
