import {useEffect, useState} from 'react';
import {ControlIcon} from './ControlIcon';
import {SelectMenu} from './SelectMenu';
import type {ControllerSnapshot, OutboundCallerId, OutboundContact} from './types';
import {WebexController} from './WebexController';

interface OutboundDialerProps {
  controller: WebexController;
  snapshot: ControllerSnapshot;
  onClose: () => void;
}

export function OutboundDialer({controller, snapshot, onClose}: OutboundDialerProps) {
  const [number, setNumber] = useState('');
  const [selectedContact, setSelectedContact] = useState<OutboundContact>();
  const [contacts, setContacts] = useState<OutboundContact[]>([]);
  const [contactCount, setContactCount] = useState(0);
  const [callerIds, setCallerIds] = useState<OutboundCallerId[]>([]);
  const [callerId, setCallerId] = useState('');
  const [search, setSearch] = useState('');
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [dialing, setDialing] = useState(false);
  const [directoryError, setDirectoryError] = useState('');
  const [callerIdError, setCallerIdError] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    if (snapshot.addressBookConfigured) {
      void controller.searchOutboundContacts().then((result) => {
        if (!active) return;
        setContacts(result.contacts);
        setContactCount(result.totalRecords);
      }).catch(() => {
        if (active) setDirectoryError('Address book could not be loaded. Try searching again.');
      });
    }
    void controller.getOutboundCallerIds().then((entries) => {
      if (!active) return;
      setCallerIds(entries);
      setCallerId(entries[0]?.number || '');
    }).catch(() => {
      if (active) setCallerIdError('Caller ID choices could not be loaded. The default caller ID will be used.');
    });
    return () => { active = false; };
  }, [controller, snapshot.addressBookConfigured]);

  const searchContacts = async () => {
    setLoadingContacts(true);
    setDirectoryError('');
    try {
      const result = await controller.searchOutboundContacts(search);
      setContacts(result.contacts);
      setContactCount(result.totalRecords);
    } catch {
      setDirectoryError('Address book search failed. Try again.');
    } finally {
      setLoadingContacts(false);
    }
  };

  const dial = async () => {
    setDialing(true);
    setError('');
    try {
      await controller.startOutboundCall(number, callerId, selectedContact);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The outbound call could not be started.');
    } finally {
      setDialing(false);
    }
  };

  return (
    <section className="outbound-composer" aria-labelledby="outbound-title">
      <div className="outbound-heading">
        <div>
          <p className="section-kicker">New interaction</p>
          <h3 id="outbound-title">Place an outbound call</h3>
        </div>
        <button type="button" className="outbound-close" aria-label="Close outbound dialer" onClick={onClose}>
          <ControlIcon name="close" />
        </button>
      </div>
      <p className="outbound-help">The call will use your current Contact Center station. Webex App may ask you to connect its leg before dialing the customer.</p>
      {snapshot.addressBookConfigured && (
        <div className="outbound-directory">
          <label htmlFor="outbound-search">Address book</label>
          <form className="outbound-search" onSubmit={(event) => { event.preventDefault(); void searchContacts(); }}>
            <input id="outbound-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or number" />
            <button type="submit" className="button secondary" disabled={loadingContacts}>{loadingContacts ? 'Searching…' : 'Search'}</button>
          </form>
          {directoryError && <p className="outbound-error" role="alert">{directoryError}</p>}
          {!directoryError && contacts.length === 0 && <p className="outbound-help">No address book entries found.</p>}
          {contacts.length > 0 && (
            <div className="outbound-contacts" role="list" aria-label="Address book contacts">
              {contacts.map((contact) => (
                <button type="button" role="listitem" key={contact.id} className={`outbound-contact ${selectedContact?.id === contact.id ? 'is-selected' : ''}`}
                  onClick={() => { setSelectedContact(contact); setNumber(contact.number); setError(''); }}>
                  <strong>{contact.name || contact.number}</strong><span>{contact.number}</span>
                </button>
              ))}
            </div>
          )}
          {contactCount > contacts.length && <small className="outbound-help">Showing the first {contacts.length} of {contactCount} matches. Refine your search to find more.</small>}
        </div>
      )}
      {snapshot.adhocDialingEnabled ? (
        <label htmlFor="outbound-number">Number to dial
          <input id="outbound-number" inputMode="tel" autoComplete="off" placeholder="+14085550100" value={number}
            onChange={(event) => { setNumber(event.target.value); setSelectedContact(undefined); }} />
        </label>
      ) : (
        <div className="outbound-selected-number">
          <span>Number to dial</span><strong>{selectedContact?.number || 'Select an address book contact'}</strong>
          <small>Manual dialing is disabled in your agent profile.</small>
        </div>
      )}
      {callerIds.length > 0 && (
        <div className="outbound-caller-id">
          <span>Caller ID</span>
          <SelectMenu ariaLabel="Outbound caller ID" value={callerId} options={callerIds.map((entry) => ({value: entry.number, label: `${entry.name || 'Caller ID'} · ${entry.number}`}))} onChange={setCallerId} />
        </div>
      )}
      {callerIdError && <p className="outbound-help">{callerIdError}</p>}
      {error && <p className="outbound-error" role="alert">{error}</p>}
      <div className="outbound-actions">
        <button type="button" className="button secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="button primary" disabled={dialing || snapshot.outboundRequestPending || !number.trim()} onClick={() => void dial()}>
          {dialing ? 'Starting call…' : 'Call number'}
        </button>
      </div>
    </section>
  );
}
