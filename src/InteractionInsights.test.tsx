// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {InteractionInsights} from './InteractionInsights';
import type {WebexController} from './WebexController';
import {initialSnapshot} from './types';

afterEach(cleanup);

describe('InteractionInsights tab focus', () => {
  it('returns to Summary for every new consult or transfer focus request', () => {
    const snapshot = {
      ...initialSnapshot,
      interactionId: 'interaction-1',
      callStatus: 'connected' as const,
      aiSummaryStatus: 'received' as const,
      midCallSummary: 'The caller needs help.',
    };
    const props = {
      snapshot,
      controller: {} as WebexController,
      busy: '',
      run: vi.fn(async () => undefined),
      summaryFocusRequest: 0,
    };
    const {rerender} = render(<InteractionInsights {...props} />);

    fireEvent.click(screen.getByRole('tab', {name: 'Transcript'}));
    expect(screen.getByRole('tab', {name: 'Transcript'}).getAttribute('aria-selected')).toBe('true');

    rerender(<InteractionInsights {...props} />);
    expect(screen.getByRole('tab', {name: 'Transcript'}).getAttribute('aria-selected')).toBe('true');

    rerender(<InteractionInsights {...props} summaryFocusRequest={1} />);
    expect(screen.getByRole('tab', {name: 'Summary'}).getAttribute('aria-selected')).toBe('true');

    fireEvent.click(screen.getByRole('tab', {name: 'Call details'}));
    rerender(<InteractionInsights {...props} summaryFocusRequest={2} />);
    expect(screen.getByRole('tab', {name: 'Summary'}).getAttribute('aria-selected')).toBe('true');
  });

  it('opens Summary when a post-call summary event adds content', () => {
    const snapshot = {
      ...initialSnapshot,
      interactionId: 'interaction-1',
      callStatus: 'wrap-up' as const,
    };
    const props = {
      snapshot,
      controller: {} as WebexController,
      busy: '',
      run: vi.fn(async () => undefined),
      summaryFocusRequest: 0,
    };
    const {rerender} = render(<InteractionInsights {...props} />);

    fireEvent.click(screen.getByRole('tab', {name: 'Transcript'}));
    rerender(
      <InteractionInsights
        {...props}
        snapshot={{...snapshot, postCallSummary: 'The customer requested a callback.'}}
      />,
    );

    expect(screen.getByRole('tab', {name: 'Summary'}).getAttribute('aria-selected')).toBe('true');
  });
});
