type ControlIconName =
  | 'bell'
  | 'theme'
  | 'mute'
  | 'hold'
  | 'keypad'
  | 'record'
  | 'consult'
  | 'conference'
  | 'transfer'
  | 'phone'
  | 'headset'
  | 'webex'
  | 'desktop'
  | 'dial'
  | 'mic'
  | 'activity'
  | 'switch'
  | 'leave'
  | 'close';

interface ControlIconProps {
  name: ControlIconName;
}

const paths: Record<ControlIconName, React.ReactNode> = {
  bell: <><path d="M6 17.6h15.6l-1.95-2.86V8.5a5.85 5.85 0 0 0-11.7 0v6.24L7.8 17.6Z" /><path d="M11 21.5h5.2" /></>,
  theme: <><path d="M12 3a9 9 0 1 0 9 9c-5 2-9-2-9-9Z"/></>,
  mute: <><path d="M9 9v3a3 3 0 0 0 5.1 2.1M15 11V9a3 3 0 0 0-5.8-1"/><path d="M5 11v1a7 7 0 0 0 11.7 5.2M19 11v1a7 7 0 0 1-.7 3M12 19v3M8 22h8M4 4l16 16"/></>,
  hold: <><path d="M8 5v14M16 5v14"/></>,
  keypad: <><circle cx="7" cy="7" r="1"/><circle cx="12" cy="7" r="1"/><circle cx="17" cy="7" r="1"/><circle cx="7" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="17" cy="12" r="1"/><circle cx="7" cy="17" r="1"/><circle cx="12" cy="17" r="1"/><circle cx="17" cy="17" r="1"/></>,
  record: <><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/></>,
  consult: <><circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 8h5M18.5 5.5v5"/></>,
  conference: <><circle cx="8" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M2.5 19a5.5 5.5 0 0 1 11 0M14 19a4.5 4.5 0 0 1 7.5-3.3"/></>,
  transfer: <><path d="M5 7h12M14 4l3 3-3 3M19 17H7M10 14l-3 3 3 3"/></>,
  phone: <><path d="M7 4 4.5 6.5c1.2 6.5 6.5 11.8 13 13L20 17l-4-3-2 2c-2.4-1-4.9-3.5-6-6l2-2-3-4Z"/></>,
  headset: <><path d="M4 13v-2a8 8 0 0 1 16 0v2"/><path d="M4 13h3v6H5a2 2 0 0 1-2-2v-2a2 2 0 0 1 1-2ZM20 13h-3v6h2a2 2 0 0 0 2-2v-2a2 2 0 0 0-1-2ZM17 19c0 1.7-1.3 3-3 3h-2"/></>,
  webex: <><path d="M7.5 5.5a7.5 7.5 0 1 0 9 0"/><path d="M8.5 8.5a4.5 4.5 0 1 0 7 0"/><circle cx="12" cy="12" r="1.4"/></>,
  desktop: <><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></>,
  dial: <><path d="M7 4 4.5 6.5c1.2 6.5 6.5 11.8 13 13L20 17l-4-3-2 2c-2.4-1-4.9-3.5-6-6l2-2-3-4Z"/><path d="M14.5 5.5h5M17 3v5"/></>,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/></>,
  activity: <><path d="M3 12h4l2.5-7 5 14L17 12h4"/></>,
  switch: <><path d="M5 7h12M14 4l3 3-3 3M19 17H7M10 14l-3 3 3 3"/></>,
  leave: <><path d="M4 4h9v16H4zM9 12h11M17 8l4 4-4 4"/></>,
  close: <><path d="m6 6 12 12M18 6 6 18"/></>,
};

export function ControlIcon({name}: ControlIconProps) {
  return <svg className="control-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}
