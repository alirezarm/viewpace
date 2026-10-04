export type Mode = 'baseline' | 'ai';
export type ProfileName = 'relaxed' | 'normal' | 'fast';
export type Feedback = 'too_slow' | 'good' | 'too_fast';

/** A single spoken word (or evenly distributed caption token) on the media timeline. */
export interface TimedWord {
  /** Onset in media seconds. */
  t: number;
  w: string;
}

export interface Cue {
  start: number;
  end: number;
  text: string;
}

export type TimingSource = 'word' | 'cue';

export interface Transcript {
  videoId: string;
  lang: string;
  kind: string; // 'asr' for auto-generated, '' for uploaded
  source: 'player-track' | 'transcript-panel';
  timing: TimingSource;
  words: TimedWord[]; // sorted by t
  cues: Cue[];
}

export interface SpeechFeatures {
  windowStart: number;
  windowSec: number;
  words: number;
  /** Words per minute over the whole window, pauses included. */
  wpm: number;
  /** Words per minute over speaking time only (pauses removed). */
  articulationWpm: number;
  pauseCount: number;
  pauseSec: number;
  pauseRatio: number;
  /** Non-speech tags like [Music], [Applause] in the window. */
  nonSpeechTags: number;
  timing: TimingSource | 'live-dom';
}

export type AiAvailability =
  | 'unsupported' // no LanguageModel global in this Chrome
  | 'unavailable' // device/language not supported
  | 'downloadable'
  | 'downloading'
  | 'available'
  | 'disabled' // provider turned off by user / mode
  | 'error';

export interface ComplexityResult {
  /** Normalized 0..1. */
  score: number;
  /** Raw integer 0..10 from the model. */
  raw: number;
  label: string;
  latencyMs: number;
}

export interface DecisionLogEntry {
  id: string;
  timestamp: number; // epoch ms
  videoId: string;
  videoTime: number;
  chunk: string;
  features: SpeechFeatures | null;
  aiScore: number | null; // 0..10 raw
  aiLabel: string | null;
  /** Video's running average complexity (0..10, prior-blended) the AI score was compared against. */
  aiMean: number | null;
  previousRate: number;
  selectedRate: number;
  targetRate: number;
  changed: boolean;
  mode: Mode;
  profile: ProfileName;
  reason: string;
  transcriptSource: string;
  feedback: Feedback | null;
  feedbackAt: number | null;
}
