/**
 * The languages Heirloom can SPEAK and HEAR (plan §20), separate from the four UI languages in lib/i18n/locales.ts.
 * A family in Lagos, Luanda or Paris can call the agent, dictate a plan and hear receipts in their own language while
 * the screens stay in English (or one of the UI languages). Shared by browser and server: no React, no browser APIs.
 *
 * `support` says which ElevenLabs product can handle the language:
 *  - agent: the voice call (Agents Platform)        - speech: text to speech (receipts, Legacy Voice)
 *  - listen: speech to text (Scribe)
 * The flags are the lead's starting point; the el/agent branch checks them against ElevenLabs' current docs and
 * corrects them here (one place). Never offer a capability for a language whose flag is false.
 */
import type { Locale } from "../i18n/locales";

export type VoiceLanguage =
  | "en" | "zu" | "st" | "af"            // the UI languages
  | "fr" | "pt" | "es" | "ar" | "sw" | "hi" | "zh"; // widely spoken, for growth beyond South Africa

export interface VoiceLanguageInfo {
  /** Named in itself, for the picker. */
  name: string;
  /** English name, for prompts and logs. */
  english: string;
  /** BCP 47 tag for `lang` attributes. */
  tag: string;
  /** ISO 639-1 code ElevenLabs expects. */
  elevenlabs: string;
  /** Right-to-left script. */
  rtl?: boolean;
  support: { agent: boolean; speech: boolean; listen: boolean };
}

export const VOICE_LANGUAGES: Record<VoiceLanguage, VoiceLanguageInfo> = {
  en: { name: "English", english: "English", tag: "en-ZA", elevenlabs: "en", support: { agent: true, speech: true, listen: true } },
  zu: { name: "isiZulu", english: "isiZulu", tag: "zu-ZA", elevenlabs: "zu", support: { agent: false, speech: false, listen: true } },
  st: { name: "Sesotho", english: "Sesotho", tag: "st-ZA", elevenlabs: "st", support: { agent: false, speech: false, listen: false } },
  af: { name: "Afrikaans", english: "Afrikaans", tag: "af-ZA", elevenlabs: "af", support: { agent: false, speech: false, listen: true } },
  fr: { name: "Français", english: "French", tag: "fr", elevenlabs: "fr", support: { agent: true, speech: true, listen: true } },
  pt: { name: "Português", english: "Portuguese", tag: "pt", elevenlabs: "pt", support: { agent: true, speech: true, listen: true } },
  es: { name: "Español", english: "Spanish", tag: "es", elevenlabs: "es", support: { agent: true, speech: true, listen: true } },
  ar: { name: "العربية", english: "Arabic", tag: "ar", elevenlabs: "ar", rtl: true, support: { agent: true, speech: true, listen: true } },
  sw: { name: "Kiswahili", english: "Swahili", tag: "sw", elevenlabs: "sw", support: { agent: false, speech: false, listen: true } },
  hi: { name: "हिन्दी", english: "Hindi", tag: "hi", elevenlabs: "hi", support: { agent: true, speech: true, listen: true } },
  zh: { name: "中文", english: "Mandarin Chinese", tag: "zh", elevenlabs: "zh", support: { agent: true, speech: true, listen: true } },
};

export const VOICE_LANGUAGE_CODES = Object.keys(VOICE_LANGUAGES) as VoiceLanguage[];

/** Where the browser remembers the spoken language (no cookie). Unset = follow the UI language. */
export const VOICE_LANGUAGE_STORAGE_KEY = "heirloom.voiceLang";

export function isVoiceLanguage(v: unknown): v is VoiceLanguage {
  return typeof v === "string" && v in VOICE_LANGUAGES;
}

export type VoiceCapability = keyof VoiceLanguageInfo["support"];

/** Languages that can do `capability`, in picker order. */
export function languagesFor(capability: VoiceCapability): VoiceLanguage[] {
  return VOICE_LANGUAGE_CODES.filter((l) => VOICE_LANGUAGES[l].support[capability]);
}

/**
 * The language to use for `capability`: the chosen spoken language if it can, else the UI language if it can,
 * else English. Never returns a language that can't do it.
 */
export function resolveVoiceLanguage(capability: VoiceCapability, chosen: VoiceLanguage | null, ui: Locale): VoiceLanguage {
  if (chosen && VOICE_LANGUAGES[chosen].support[capability]) return chosen;
  if (VOICE_LANGUAGES[ui].support[capability]) return ui;
  return "en";
}
