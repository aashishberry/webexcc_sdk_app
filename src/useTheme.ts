import {useEffect, useState} from 'react';

type ThemeMode = 'system' | 'light' | 'dark';

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    try {
      const stored = window.localStorage.getItem('webex-poc-theme');
      return stored === 'light' || stored === 'dark' ? stored : 'system';
    } catch {
      return 'system';
    }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    try {
      window.localStorage.setItem('webex-poc-theme', mode);
    } catch {
      // Theme selection remains usable when browser storage is unavailable.
    }
  }, [mode]);

  const cycle = () => setMode((current) =>
    current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system',
  );

  return {mode, cycle};
}
