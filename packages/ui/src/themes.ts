import type { ColorToken, Radius, Shadow, Space, TextVariant } from './types.ts';

/**
 * A theme is a value for every token. Switching one restyles the whole page
 * without touching a single element, which is the point of tokens.
 */
export interface Theme {
  id: string;
  name: string;
  /** Three words, for the picker. */
  mood: string;
  colors: Record<ColorToken, string>;
  font: { body: string; display: string };
  radius: Record<Radius, string>;
  space: Record<Space, string>;
  shadow: Record<Shadow, string>;
  text: Record<TextVariant, { size: string; weight: number; line: string; tracking?: string; display?: boolean; phone?: string }>;
}

const SPACE: Record<Space, string> = { none: '0px', xs: '4px', sm: '8px', md: '16px', lg: '24px', xl: '40px', '2xl': '64px' };
const TEXT: Theme['text'] = {
  title: { size: '44px', weight: 700, line: '1.1', tracking: '-0.02em', display: true, phone: '32px' },
  heading: { size: '28px', weight: 650, line: '1.2', tracking: '-0.01em', display: true, phone: '22px' },
  subheading: { size: '19px', weight: 600, line: '1.35', phone: '17px' },
  body: { size: '15px', weight: 400, line: '1.6' },
  caption: { size: '13px', weight: 400, line: '1.45' },
  label: { size: '12px', weight: 600, line: '1.3', tracking: '0.04em' },
};
const SANS = `Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif`;

export const THEMES: Theme[] = [
  {
    id: 'clean',
    name: 'Clean',
    mood: 'bright, calm, neutral',
    colors: {
      page: '#F6F7F9', surface: '#FFFFFF', raised: '#EEF0F3', accent: '#3D63DD', accentSoft: '#E6ECFC',
      text: '#16181D', muted: '#646B76', inverse: '#FFFFFF', danger: '#D2453A', success: '#2F8F5B',
    },
    font: { body: SANS, display: SANS },
    radius: { none: '0px', sm: '6px', md: '10px', lg: '16px', full: '999px' },
    space: SPACE,
    shadow: { none: 'none', soft: '0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.08)', lifted: '0 12px 32px -8px rgba(16,24,40,.18)' },
    text: TEXT,
  },
  {
    id: 'midnight',
    name: 'Midnight',
    mood: 'dark, focused, sharp',
    colors: {
      page: '#0C0E12', surface: '#15181E', raised: '#1E222A', accent: '#7C9BFF', accentSoft: '#1D2640',
      text: '#ECEEF2', muted: '#8A93A1', inverse: '#0C0E12', danger: '#F0715F', success: '#5CC98E',
    },
    font: { body: SANS, display: SANS },
    radius: { none: '0px', sm: '6px', md: '10px', lg: '16px', full: '999px' },
    space: SPACE,
    shadow: { none: 'none', soft: '0 1px 2px rgba(0,0,0,.4)', lifted: '0 16px 40px -10px rgba(0,0,0,.6)' },
    text: TEXT,
  },
  {
    id: 'paper',
    name: 'Paper',
    mood: 'warm, editorial, quiet',
    colors: {
      page: '#FAF7F2', surface: '#FFFDF9', raised: '#F1ECE3', accent: '#B4532A', accentSoft: '#F6E5DA',
      text: '#2B2622', muted: '#7A7068', inverse: '#FFFDF9', danger: '#B8342A', success: '#4F7F4A',
    },
    font: { body: `'Source Serif 4', Georgia, 'Times New Roman', serif`, display: `'Fraunces', Georgia, serif` },
    radius: { none: '0px', sm: '3px', md: '6px', lg: '10px', full: '999px' },
    space: SPACE,
    shadow: { none: 'none', soft: '0 1px 2px rgba(60,40,20,.08)', lifted: '0 14px 30px -12px rgba(60,40,20,.22)' },
    text: { ...TEXT, title: { ...TEXT.title, weight: 600 }, heading: { ...TEXT.heading, weight: 600 } },
  },
  {
    id: 'playful',
    name: 'Playful',
    mood: 'bold, round, friendly',
    colors: {
      page: '#FFF8EC', surface: '#FFFFFF', raised: '#FFEBC7', accent: '#FF5A36', accentSoft: '#FFE1D8',
      text: '#1F1A33', muted: '#6E6788', inverse: '#FFFFFF', danger: '#E0344B', success: '#1E9E6A',
    },
    font: { body: `'Nunito', ui-rounded, system-ui, sans-serif`, display: `'Nunito', ui-rounded, system-ui, sans-serif` },
    radius: { none: '0px', sm: '10px', md: '16px', lg: '24px', full: '999px' },
    space: SPACE,
    shadow: { none: 'none', soft: '0 2px 0 rgba(31,26,51,.12)', lifted: '0 6px 0 rgba(31,26,51,.14)' },
    text: { ...TEXT, title: { ...TEXT.title, weight: 800 }, heading: { ...TEXT.heading, weight: 800 } },
  },
  {
    id: 'mono',
    name: 'Mono',
    mood: 'stark, technical, crisp',
    colors: {
      page: '#FFFFFF', surface: '#FFFFFF', raised: '#F2F2F2', accent: '#111111', accentSoft: '#EDEDED',
      text: '#111111', muted: '#6B6B6B', inverse: '#FFFFFF', danger: '#C62828', success: '#2E7D32',
    },
    font: { body: `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`, display: `'JetBrains Mono', ui-monospace, monospace` },
    radius: { none: '0px', sm: '0px', md: '2px', lg: '4px', full: '999px' },
    space: SPACE,
    shadow: { none: 'none', soft: '0 0 0 1px #111111', lifted: '4px 4px 0 #111111' },
    text: { ...TEXT, title: { ...TEXT.title, size: '38px' }, body: { ...TEXT.body, size: '14px' } },
  },
];

export const themeById = (id: string): Theme => THEMES.find((theme) => theme.id === id) ?? THEMES[0]!;
