type DiagnosticOutcome = 'started' | 'succeeded' | 'failed' | 'observed';

export function reportBackendEvent(
  event: string,
  outcome: DiagnosticOutcome,
  details: Record<string, string | number | boolean> = {},
): void {
  if (typeof window === 'undefined') return;
  void fetch('/api/diagnostics/events', {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({event, outcome, details}),
  }).catch(() => undefined);
}
