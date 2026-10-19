export type ThemeId = 'slade' | 'oled' | 'cobalt' | 'ida';

export interface ThemeOption {
  id: ThemeId;
  name: string;
  tag: string;
}

export const THEMES: ThemeOption[] = [
  { id: 'slade', name: 'Slade Industrial (Amber Forge)', tag: 'SLADE3 / id Tech' },
  { id: 'oled', name: 'Pitch Black (OLED)', tag: 'RAD / OLED' },
  { id: 'cobalt', name: 'Classic Dark Navy (Cobalt)', tag: 'Cobalt Blue' },
  { id: 'ida', name: 'IDA Classic Dark (Graphite)', tag: 'IDA Pro Dark' },
];

export const DEFAULT_THEME: ThemeId = 'slade';
