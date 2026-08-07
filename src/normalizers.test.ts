import {describe, expect, it} from 'vitest';
import {normalizeTeams} from './normalizers';

describe('normalizeTeams', () => {
  it('normalizes the id/name payload returned by WxCC profiles', () => {
    expect(normalizeTeams([
      {id: 'team-a', name: 'Support'},
      {id: 'team-b', name: 'Escalations'},
    ])).toEqual([
      {id: 'team-a', name: 'Support'},
      {id: 'team-b', name: 'Escalations'},
    ]);
  });

  it('accepts the teamId/teamName shape from the 3.12.0 declarations', () => {
    expect(normalizeTeams([{teamId: 'team-a', teamName: 'Support'}])).toEqual([
      {id: 'team-a', name: 'Support'},
    ]);
  });

  it('drops entries without an identifier and falls back to the id for a missing name', () => {
    expect(normalizeTeams([{name: 'Invalid'}, {id: 'team-a'}])).toEqual([
      {id: 'team-a', name: 'team-a'},
    ]);
  });
});
