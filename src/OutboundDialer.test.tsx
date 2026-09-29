// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {OutboundDialer} from './OutboundDialer';
import {initialSnapshot} from './types';
import type {WebexController} from './WebexController';

afterEach(cleanup);

describe('OutboundDialer', () => {
  it('dials a selected address book contact when manual entry is disabled', async () => {
    const startOutboundCall = vi.fn(async () => undefined);
    const controller = {
      searchOutboundContacts: vi.fn(async () => ({contacts: [{id: 'contact-1', name: 'Customer', number: '+14085550100'}], totalRecords: 1})),
      getOutboundCallerIds: vi.fn(async () => []),
      startOutboundCall,
    } as unknown as WebexController;
    const onClose = vi.fn();
    render(<OutboundDialer controller={controller} snapshot={{...initialSnapshot, outboundEnabled: true, addressBookConfigured: true}} onClose={onClose} />);

    fireEvent.click(await screen.findByText('Customer'));
    fireEvent.click(screen.getByRole('button', {name: 'Call number'}));

    await waitFor(() => expect(startOutboundCall).toHaveBeenCalledWith('+14085550100', '', {
      id: 'contact-1', name: 'Customer', number: '+14085550100',
    }));
    expect(screen.queryByLabelText('Number to dial')).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('allows an ad-hoc number when the agent profile enables manual dialing', async () => {
    const startOutboundCall = vi.fn(async () => undefined);
    const controller = {
      searchOutboundContacts: vi.fn(async () => ({contacts: [], totalRecords: 0})),
      getOutboundCallerIds: vi.fn(async () => []),
      startOutboundCall,
    } as unknown as WebexController;
    render(<OutboundDialer controller={controller} snapshot={{...initialSnapshot, outboundEnabled: true, adhocDialingEnabled: true}} onClose={() => undefined} />);

    fireEvent.change(screen.getByLabelText('Number to dial'), {target: {value: '+14085550101'}});
    fireEvent.click(screen.getByRole('button', {name: 'Call number'}));

    await waitFor(() => expect(startOutboundCall).toHaveBeenCalledWith('+14085550101', '', undefined));
  });
});
