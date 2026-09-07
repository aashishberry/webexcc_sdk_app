import {useState} from 'react';
import type {WebexPocController} from './WebexPocController';
import type {ControllerSnapshot} from './types';

type InsightTab = 'context' | 'transcript' | 'assist' | 'summary' | 'stats';

interface InteractionInsightsProps {
  snapshot: ControllerSnapshot;
  controller: WebexPocController;
  busy: string;
  run: (name: string, action: () => void | Promise<void>) => Promise<void>;
}

function labelForRole(role: string): string {
  const normalized = role.toLowerCase();
  if (normalized.includes('agent')) return 'Agent';
  if (normalized.includes('customer') || normalized.includes('caller')) return 'Customer';
  return role || 'Speaker';
}

function formatMetricDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  if (minutes < 60) return `${minutes}m ${String(remainder).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function ContextView({snapshot}: {snapshot: ControllerSnapshot}) {
  const context = snapshot.interactionContext;
  const values = [
    ['Queue', context.queueName],
    ['Reason', context.reason],
    ['IVR path', context.ivrPath],
    ['Entry point', context.entryPoint],
    ['Language', context.language],
  ].filter(([, value]) => value);

  return (
    <div className="insight-content">
      <div className="insight-customer">
        <span className="insight-avatar">{snapshot.callerName.charAt(0) || 'C'}</span>
        <div>
          <strong>{snapshot.callerName || 'Contact Center caller'}</strong>
          <span>{snapshot.callerNumber || 'Number unavailable'}</span>
        </div>
      </div>
      {values.length ? (
        <dl className="context-values">
          {values.map(([label, value]) => (
            <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
          ))}
        </dl>
      ) : (
        <div className="insight-empty compact">
          Interaction context will appear when the flow supplies it.
        </div>
      )}
      <details className="technical-details">
        <summary>Technical details</summary>
        <span>Interaction ID</span>
        <code title={snapshot.interactionId}>{snapshot.interactionId || 'Unavailable'}</code>
      </details>
    </div>
  );
}

function TranscriptView({snapshot, controller, busy, run}: InteractionInsightsProps) {
  const canRetry =
    snapshot.realtimeTranscriptionEnabled &&
    ['connected', 'held'].includes(snapshot.callStatus) &&
    ['waiting', 'error', 'stopped'].includes(snapshot.transcriptionStatus);
  const statusMessage = snapshot.transcriptionMessage || (
    snapshot.transcriptionStatus === 'starting'
      ? 'Starting transcript streaming…'
      : snapshot.transcriptionStatus === 'active'
        ? 'Live transcript streaming is active.'
        : 'Waiting for transcript audio.'
  );

  return (
    <div className="insight-content transcript-list" aria-live="polite">
      <div className={`transcription-status status-${snapshot.transcriptionStatus}`}>
        <span aria-hidden="true" />
        <p>{statusMessage}</p>
      </div>
      {snapshot.transcripts.length ? snapshot.transcripts.map((entry) => (
        <article className={`transcript-entry role-${entry.role.toLowerCase()}`} key={entry.id}>
          <div>
            <strong>{labelForRole(entry.role)}</strong>
            <time>{new Date(entry.timestamp).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}</time>
          </div>
          <p>{entry.content}</p>
        </article>
      )) : (
        <div className="insight-empty">
          <strong>No transcript yet</strong>
          <span>Transcript entries appear here after streaming starts and speech is detected.</span>
          {canRetry && (
            <button
              type="button"
              className="button secondary"
              disabled={busy !== '' || snapshot.transcriptionStatus === 'starting'}
              onClick={() => void run('ai-transcript', () => controller.startTranscription())}
            >
              Retry transcript
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AssistanceView({snapshot, controller, busy, run}: InteractionInsightsProps) {
  const [context, setContext] = useState('');
  const latest = snapshot.aiSuggestions[0];

  const copySuggestion = async () => {
    if (!latest) return;
    await navigator.clipboard.writeText(latest.content);
    await controller.sendAssistanceFeedback(latest.id, 'copyButton');
  };

  return (
    <div className="insight-content">
      {latest ? (
        <article className="suggestion-card">
          <span className="suggestion-label">Suggested response</span>
          <p>{latest.content}</p>
          <div className="suggestion-actions">
            <button type="button" onClick={() => void run('ai-copy', copySuggestion)}>Copy</button>
            <button type="button" onClick={() => void run('ai-like', () => controller.sendAssistanceFeedback(latest.id, 'likeButton'))}>Helpful</button>
            <button type="button" onClick={() => void run('ai-dislike', () => controller.sendAssistanceFeedback(latest.id, 'dislikeButton'))}>Not helpful</button>
          </div>
        </article>
      ) : (
        <div className="insight-empty compact">
          Ask AI Assistant for a response based on the active conversation.
        </div>
      )}
      <label className="assist-context">
        Optional context
        <textarea
          value={context}
          maxLength={1000}
          placeholder="Add a detail the assistant should consider"
          onChange={(event) => setContext(event.target.value)}
        />
      </label>
      <button
        type="button"
        className="button primary full"
        disabled={busy !== '' || snapshot.aiAssistanceLoading}
        onClick={() => void run('ai-assist', () => controller.requestAssistance(context))}
      >
        {snapshot.aiAssistanceLoading ? 'Requesting assistance…' : latest ? 'Refresh suggestion' : 'Get assistance'}
      </button>
      {snapshot.aiError && <div className="notice error-notice">{snapshot.aiError}</div>}
    </div>
  );
}

function SummaryView({snapshot, controller, busy, run}: InteractionInsightsProps) {
  const summary = snapshot.postCallSummary || snapshot.midCallSummary;
  const postCall = snapshot.callStatus === 'wrap-up' || snapshot.callStatus === 'ended';
  return (
    <div className="insight-content">
      {summary ? (
        <article className="summary-card">
          <span className="suggestion-label">{snapshot.postCallSummary ? 'Post-call summary' : 'Mid-call summary'}</span>
          <p>{summary}</p>
        </article>
      ) : (
        <div className="insight-empty">
          <strong>No summary generated</strong>
          <span>Generate a concise summary when the AI summary feature is enabled for this interaction.</span>
        </div>
      )}
      <button
        type="button"
        className="button secondary full"
        disabled={busy !== '' || snapshot.aiSummaryLoading}
        onClick={() => void run('ai-summary', () => controller.requestSummary(postCall ? 'post-call' : 'mid-call'))}
      >
        {snapshot.aiSummaryLoading ? 'Summary requested…' : `Generate ${postCall ? 'post-call' : 'mid-call'} summary`}
      </button>
    </div>
  );
}

function StatisticsView({snapshot, controller, busy}: InteractionInsightsProps) {
  return (
    <div className="insight-content statistics-view">
      <div className="performance-heading">
        <div>
          <p className="section-kicker">My performance</p>
          <h3>Today</h3>
        </div>
        <button
          type="button"
          className="performance-refresh"
          disabled={busy !== '' || snapshot.performanceStatus === 'loading'}
          onClick={() => void controller.loadPerformance()}
        >
          {snapshot.performanceStatus === 'loading' ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {snapshot.performanceStatus === 'loading' ? (
        <div className="performance-grid" aria-label="Loading performance statistics">
          {[0, 1, 2, 3].map((item) => <span key={item} className="metric-skeleton" />)}
        </div>
      ) : snapshot.performanceStatus === 'ready' && snapshot.performance ? (
        <div className="performance-grid">
          <article className="performance-card">
            <span>Completed</span>
            <strong>{snapshot.performance.handled}</strong>
            <small>interactions</small>
          </article>
          <article className="performance-card">
            <span>Avg talk</span>
            <strong>{formatMetricDuration(snapshot.performance.averageConnectedSeconds)}</strong>
            <small>connected time</small>
          </article>
          <article className="performance-card">
            <span>Avg hold</span>
            <strong>{formatMetricDuration(snapshot.performance.averageHoldSeconds)}</strong>
            <small>per interaction</small>
          </article>
          <article className="performance-card">
            <span>Avg wrap-up</span>
            <strong>{formatMetricDuration(snapshot.performance.averageWrapupSeconds)}</strong>
            <small>per interaction</small>
          </article>
        </div>
      ) : (
        <div className="performance-unavailable">
          <strong>Reporting unavailable</strong>
          <span>{snapshot.performanceMessage || 'Performance statistics are unavailable for this session.'}</span>
        </div>
      )}
      <p className="performance-caption">
        Completed telephony interactions where you were the last handling agent. Times use your local day.
      </p>
    </div>
  );
}

export function InteractionInsights(props: InteractionInsightsProps) {
  const [tab, setTab] = useState<InsightTab>('transcript');
  const {snapshot} = props;
  const tabs: Array<{id: InsightTab; label: string; count?: number}> = [
    {id: 'transcript', label: 'Transcript', count: snapshot.transcripts.length},
    {id: 'assist', label: 'Assist', count: snapshot.aiSuggestions.length},
    {id: 'summary', label: 'Summary'},
    {id: 'stats', label: 'Statistics'},
    {id: 'context', label: 'Call details'},
  ];

  return (
    <section className="insights-panel" aria-label="Conversation workspace">
      <div className="insight-tabs" role="tablist" aria-label="Interaction information">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'is-active' : ''}
            onClick={() => setTab(item.id)}
          >
            {item.label}{item.count ? <span>{item.count}</span> : null}
          </button>
        ))}
      </div>
      {tab === 'context' && <ContextView snapshot={snapshot} />}
      {tab === 'transcript' && <TranscriptView {...props} />}
      {tab === 'assist' && <AssistanceView {...props} />}
      {tab === 'summary' && <SummaryView {...props} />}
      {tab === 'stats' && <StatisticsView {...props} />}
    </section>
  );
}
