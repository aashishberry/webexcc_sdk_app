import type {AgentTeam} from './types';

type TeamPayload = {
  id?: unknown;
  name?: unknown;
  teamId?: unknown;
  teamName?: unknown;
};

/**
 * WxCC deployments currently return both `{id, name}` and
 * `{teamId, teamName}` despite the 3.12.0 declaration exposing only the latter.
 */
export function normalizeTeams(payload: unknown): AgentTeam[] {
  if (!Array.isArray(payload)) return [];

  return payload.flatMap((candidate): AgentTeam[] => {
    if (!candidate || typeof candidate !== 'object') return [];
    const team = candidate as TeamPayload;
    const id = team.teamId ?? team.id;
    const name = team.teamName ?? team.name;
    if (typeof id !== 'string' || !id) return [];

    return [{id, name: typeof name === 'string' && name ? name : id}];
  });
}
