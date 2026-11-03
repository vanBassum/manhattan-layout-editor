const ICON_PATHS = {
  app: 'M4 4h6v6H4z M14 14h6v6h-6z M10 7h4v10 M7 10v7h7',
  chevronDown: 'M7 10l5 5 5-5',
  chevronRight: 'M10 7l5 5-5 5',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  file: 'M6 3h8l4 4v14H6z M14 3v4h4',
  newFile: 'M6 3h8l4 4v14H6z M14 3v4h4 M12 10v7 M8.5 13.5h7',
  folder: 'M3 6h6l2 2h10v11H3z',
  computer: 'M3 4h18v12H3z M8 20h8 M12 16v4',
  external: 'M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6',
  arrowUp: 'M12 19V5 M6 11l6-6 6 6',
  settings: 'M12 9a3 3 0 1 1 0 6a3 3 0 1 1 0-6 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.9 4.9l2.1 2.1 M17 17l2.1 2.1 M4.9 19.1l2.1-2.1 M17 7l2.1-2.1',
  user: 'M12 4a4 4 0 1 1 0 8a4 4 0 1 1 0-8 M4 21c0-4 3.6-6 8-6s8 2 8 6',
  importExport: 'M4 8h13l-3-3 M20 16H7l3 3',
  open: 'M3 7h6l2 2h10v10H3z M3 7V5h6',
  save: 'M5 4h11l3 3v13H5z M8 4v5h7V4 M8 20v-6h8v6',
  sample: 'M4 6h16v12H4z M8 10h8 M8 14h5',
  grid: 'M4 4h16v16H4z M4 12h16 M12 4v16',
  export: 'M12 4v11 M7 10l5 5 5-5 M5 20h14',
  fit: 'M4 9V4h5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5',
  rotate: 'M20 12a8 8 0 1 1-2.3-5.7 M20 4v4h-4',
  flipHorizontal: 'M12 3v18 M9 7L3 17h6z M15 7l6 10h-6z',
  flipVertical: 'M3 12h18 M7 9L17 3v6z M7 15l10 6v-6z',
  leads: 'M4 12h5 M15 12h5 M9 8h6v8H9z',
  select: 'M6 3l13 8-6 1.5L10 19z',
  pan: 'M12 3v18 M3 12h18 M9 6l3-3 3 3 M9 18l3 3 3-3 M6 9l-3 3 3 3 M18 9l3 3-3 3',
  moveBody: 'M9 9h6v6H9z M3 12h2 M19 12h2 M5 10v4 M19 10v4',
  search: 'M10 4a6 6 0 1 1 0 12a6 6 0 1 1 0-12 M15 15l5 5',
  convert: 'M4 8h14l-3-3 M20 16H6l3 3',
  plus: 'M12 5v14 M5 12h14',
  cloud: 'M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9.5 4.3 4.3 0 0 0 7 18z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  schematic: 'M2 12h4 M6 9h8v6H6z M14 12h4 M18 7v10 M20 9v6',
  split: 'M3 5h18v14H3z M12 5v14',
  wave: 'M2 12h3l2-6 4 12 3-9 2 3h6',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  probe: 'M14 3l7 7 M16 5l-9 9 M9 12l3 3 M8 16l-5 5',
  wire: 'M4 18h6V6h10 M4 18a1.5 1.5 0 1 0 0.01 0 M20 6a1.5 1.5 0 1 0 0.01 0',
  label: 'M4 7h11l5 5-5 5H4z M8 12h.01',
  sun: 'M12 8a4 4 0 1 1 0 8a4 4 0 1 1 0-8 M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  help: 'M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18 M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6 M12 17.5v.01',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M12 9a3 3 0 1 1 0 6a3 3 0 1 1 0-6',
  eyeOff: 'M2 12s3.5-7 10-7c2 0 3.7.7 5.1 1.6 M22 12s-3.5 7-10 7c-2 0-3.7-.7-5.1-1.6 M3 3l18 18',
  ai: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z',
}

export type IconName = keyof typeof ICON_PATHS

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d={ICON_PATHS[name]} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
