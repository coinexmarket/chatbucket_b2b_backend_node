/**
 * The rate card.
 *
 * Ported from `app/pricing.py`. Service keys are written into every usage
 * record and read by the dashboard, so they are shared with the Python service
 * and cannot be renamed independently.
 *
 * Rates are `Decimal`, never `number` — see `money.ts`. A rate of 0.52 held as a
 * float is 0.52000000000000002, and that error is multiplied by every minute
 * billed.
 */
import { Decimal, quantize, toDecimal, type AmountLike } from './money.js';

export interface Service {
  key: string;
  label: string;
  /** "minutes" | "characters" | "tokens" */
  unit: string;
  /** INR per `unitSize` units. */
  rate: Decimal;
  /** How many units one `rate` covers. */
  unitSize: number;
}

const LIST: Service[] = [
  // Audio services bill fractional minutes exactly.
  { key: 'stt_streaming', label: 'Speech-to-Text (streaming)', unit: 'minutes', rate: toDecimal('0.52'), unitSize: 1 },
  { key: 'stt_offline', label: 'Speech-to-Text (offline/upload)', unit: 'minutes', rate: toDecimal('0.39'), unitSize: 1 },
  { key: 'tts_streaming', label: 'Text-to-Speech (streaming)', unit: 'characters', rate: toDecimal('0.91'), unitSize: 1000 },
  { key: 'tts_offline', label: 'Text-to-Speech (offline/upload)', unit: 'characters', rate: toDecimal('0.78'), unitSize: 1000 },
  { key: 'translation', label: 'Translation', unit: 'tokens', rate: toDecimal('7.5'), unitSize: 10000 },
  { key: 'chat_agent', label: 'Chat Agent', unit: 'tokens', rate: toDecimal('4.38'), unitSize: 10000 },
  { key: 'voice_agent_web', label: 'Voice Agent (web call)', unit: 'minutes', rate: toDecimal('4.0'), unitSize: 1 },
  { key: 'voip_call', label: 'Voice Agent (VoIP call)', unit: 'minutes', rate: toDecimal('5.0'), unitSize: 1 },
];

export const SERVICES: Record<string, Service> = Object.fromEntries(
  LIST.map((s) => [s.key, s]),
);

export const SERVICE_KEYS = LIST.map((s) => s.key);

export class UnknownServiceError extends Error {}

export function getService(key: string): Service {
  const service = SERVICES[key];
  if (!service) {
    throw new UnknownServiceError(
      `Unknown service '${key}'. Valid: ${SERVICE_KEYS.join(', ')}`,
    );
  }
  return service;
}

/**
 * What a quantity of a service costs, exactly.
 *
 * `quantity / unitSize * rate`, quantized to the currency's 4dp. Division comes
 * first so a 1000-character unit size divides the quantity rather than the rate,
 * which keeps the intermediate exact.
 */
export function calculateCost(serviceKey: string, quantity: AmountLike): Decimal {
  const service = getService(serviceKey);
  return quantize(toDecimal(quantity).dividedBy(service.unitSize).times(service.rate));
}

/** JSON-serialisable description of every service. */
export function rateCard(): Array<Record<string, unknown>> {
  return LIST.map((s) => ({
    service: s.key,
    label: s.label,
    unit: s.unit,
    rate: s.rate.toNumber(),
    unit_size: s.unitSize,
    currency: 'INR',
  }));
}
