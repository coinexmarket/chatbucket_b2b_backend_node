/**
 * The rate card, and what a reported consumption costs.
 *
 * Ported from `app/pricing.py`. Service keys are written into every usage record
 * and read by the dashboard, so they are shared with the Python service and
 * cannot be renamed independently.
 *
 * Rates are `Decimal`, never `number` — see `money.ts`. A rate of 0.52 held as a
 * float is 0.52000000000000002, and that error is multiplied by every minute
 * billed and then summed across a month.
 */
import { Decimal, quantize, toDecimal, type AmountLike } from './money.js';

/**
 * Grouping/lookup key for a model name.
 *
 * Lower-cased with runs of whitespace collapsed, so "CB Paluku", "cb  paluku"
 * and " CB PALUKU " are one model for both pricing and the usage breakdown.
 * Deliberately conservative — it folds only case and spacing, so two genuinely
 * different models can never be merged.
 */
export function normalizeModelKey(model: string): string {
  return model.trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface Service {
  key: string;
  label: string;
  /** "minutes" | "characters" | "tokens" */
  unit: string;
  /** INR per `unitSize` units. */
  rate: Decimal;
  /**
   * The rate exactly as written in the card, for display.
   *
   * decimal.js normalises "4.0" to "4"; Python's Decimal keeps the trailing
   * zero, and the pricing page shows that string verbatim. Storing the literal
   * keeps the two services rendering the identical price.
   */
  rateText: string;
  /** How many units one `rate` covers. */
  unitSize: number;
  /**
   * Token services can price input and output separately — generating a token
   * costs far more than reading one. Set BOTH to enable split pricing; leave
   * both unset and the flat `rate` applies to the combined total.
   */
  inputRate?: Decimal;
  outputRate?: Decimal;
  /**
   * The smallest billable unit. `SECOND` on a minutes service means a
   * 12.3-second call bills as 13 seconds rather than an exact fraction.
   * Undefined leaves the quantity exact — the current behaviour.
   */
  billingIncrement?: Decimal;
}

/** One second, expressed in minutes — the increment for audio services. */
export const SECOND = new Decimal(1).dividedBy(60);

const LIST: Service[] = [
  // Audio services bill fractional minutes exactly. To bill per whole second
  // instead — what telcos and speech APIs do — add `billingIncrement: SECOND`
  // to each of the four `minutes` services.
  { key: 'stt_streaming', label: 'Speech-to-Text (streaming)', unit: 'minutes', rate: toDecimal('0.52'), rateText: '0.52', unitSize: 1 },
  { key: 'stt_offline', label: 'Speech-to-Text (offline/upload)', unit: 'minutes', rate: toDecimal('0.39'), rateText: '0.39', unitSize: 1 },
  { key: 'tts_streaming', label: 'Text-to-Speech (streaming)', unit: 'characters', rate: toDecimal('0.91'), rateText: '0.91', unitSize: 1000 },
  { key: 'tts_offline', label: 'Text-to-Speech (offline/upload)', unit: 'characters', rate: toDecimal('0.78'), rateText: '0.78', unitSize: 1000 },
  // The two token services are the candidates for split pricing: set inputRate
  // and outputRate on one to switch it over. Both must be set.
  { key: 'translation', label: 'Translation', unit: 'tokens', rate: toDecimal('7.5'), rateText: '7.5', unitSize: 10000 },
  { key: 'chat_agent', label: 'Chat Agent', unit: 'tokens', rate: toDecimal('4.38'), rateText: '4.38', unitSize: 10000 },
  { key: 'voice_agent_web', label: 'Voice Agent (web call)', unit: 'minutes', rate: toDecimal('4.0'), rateText: '4.0', unitSize: 1 },
  { key: 'voip_call', label: 'Voice Agent (VoIP call)', unit: 'minutes', rate: toDecimal('5.0'), rateText: '5.0', unitSize: 1 },
];

export const SERVICES: Record<string, Service> = Object.fromEntries(
  LIST.map((s) => [s.key, s]),
);
export const SERVICE_KEYS = LIST.map((s) => s.key);

function splitsInputOutput(s: { inputRate?: Decimal; outputRate?: Decimal }): boolean {
  return s.inputRate !== undefined && s.outputRate !== undefined;
}

/**
 * A price that applies to one model within a service.
 *
 * Overrides the service's rate when that model served the request — a large chat
 * model need not cost the same as a small one. `unitSize` is optional and falls
 * back to the service's.
 */
export interface ModelRate {
  service: string;
  /** Display spelling; matching is case/space-insensitive. */
  model: string;
  rate: Decimal;
  unitSize?: number;
  inputRate?: Decimal;
  outputRate?: Decimal;
}

/**
 * Per-model prices, keyed by `service|normalisedModel`.
 *
 * A model with no entry is **not** an error: callers send arbitrary model names,
 * and an unknown one must fall back to the service rate rather than fail the
 * billing call.
 */
const MODEL_RATE_LIST: ModelRate[] = [
  // e.g. { service: 'chat_agent', model: 'CB Thodu', rate: toDecimal('9.00') },
];

export const MODEL_RATES = new Map<string, ModelRate>(
  MODEL_RATE_LIST.map((m) => [`${m.service}|${normalizeModelKey(m.model)}`, m]),
);

export class UnknownServiceError extends Error {}
export class SplitPricingUnavailableError extends Error {}

export function getService(key: string): Service {
  const service = SERVICES[key];
  if (!service) {
    throw new UnknownServiceError(
      `Unknown service '${key}'. Valid: ${SERVICE_KEYS.join(', ')}`,
    );
  }
  return service;
}

function modelOverride(serviceKey: string, model?: string | null): ModelRate | undefined {
  if (!model) return undefined;
  return MODEL_RATES.get(`${serviceKey}|${normalizeModelKey(model)}`);
}

/**
 * The rate actually charged for a service, given the model that served it.
 *
 * `override` is undefined when the service's own rate applies — either no model
 * was reported, or that model has no entry.
 */
export function resolveRate(
  serviceKey: string,
  model?: string | null,
): { rate: Decimal; unitSize: number; override?: ModelRate } {
  const service = getService(serviceKey);
  const override = modelOverride(service.key, model);
  if (override) {
    return {
      rate: override.rate,
      unitSize: override.unitSize ?? service.unitSize,
      override,
    };
  }
  return { rate: service.rate, unitSize: service.unitSize };
}

/**
 * Round consumption up to the service's smallest billable unit.
 *
 * Returned unchanged when the service has no increment configured. Rounding
 * happens before pricing, so the customer is charged for whole units of whatever
 * they were told the unit is.
 */
export function billableQuantity(serviceKey: string, quantity: AmountLike): Decimal {
  const service = getService(serviceKey);
  const amount = toDecimal(quantity);
  if (!service.billingIncrement) return amount;
  return amount
    .dividedBy(service.billingIncrement)
    .ceil()
    .times(service.billingIncrement);
}

/**
 * The INR cost for `quantity` units of a service.
 *
 * `quantity` is in the service's unit (minutes / characters / tokens). When
 * `model` has a per-model price it is used instead of the service's. Exact, to
 * 4 decimal places; use `money.toJson` at the response boundary.
 */
export function calculateCost(
  serviceKey: string,
  quantity: AmountLike,
  model?: string | null,
): Decimal {
  let amount = toDecimal(quantity);
  if (amount.lessThan(0)) throw new Error('quantity must be non-negative');
  amount = billableQuantity(serviceKey, amount);
  const { rate, unitSize } = resolveRate(serviceKey, model);
  return quantize(rate.times(amount).dividedBy(unitSize));
}

/**
 * `[inputRate, outputRate, unitSize]` if split pricing applies, else null.
 *
 * A model override replaces the service's pricing *entirely* — a flat-rate
 * override on a split-rate service makes that model flat, because the more
 * specific price is the one that applies.
 */
export function splitRates(
  serviceKey: string,
  model?: string | null,
): [Decimal, Decimal, number] | null {
  const service = getService(serviceKey);
  const override = modelOverride(service.key, model);
  if (override) {
    if (splitsInputOutput(override)) {
      return [
        override.inputRate as Decimal,
        override.outputRate as Decimal,
        override.unitSize ?? service.unitSize,
      ];
    }
    return null;
  }
  if (splitsInputOutput(service)) {
    return [service.inputRate as Decimal, service.outputRate as Decimal, service.unitSize];
  }
  return null;
}

/**
 * Cost when input and output are priced separately.
 *
 * Quantized **once** at the end rather than per term — rounding each side first
 * and adding would drift by up to half a unit on every call.
 */
export function calculateSplitCost(
  serviceKey: string,
  inputQuantity: AmountLike,
  outputQuantity: AmountLike,
  model?: string | null,
): Decimal {
  const rates = splitRates(serviceKey, model);
  if (!rates) {
    throw new SplitPricingUnavailableError(
      `Service '${serviceKey}' is not priced separately for input and output. ` +
        'Send `quantity` instead of input_quantity/output_quantity.',
    );
  }
  const [inputRate, outputRate, unitSize] = rates;
  const input = toDecimal(inputQuantity);
  const output = toDecimal(outputQuantity);
  if (input.lessThan(0) || output.lessThan(0)) {
    throw new Error('quantity must be non-negative');
  }
  return quantize(
    input.times(inputRate).plus(output.times(outputRate)).dividedBy(unitSize),
  );
}

/** Per-model prices configured for one service, for the rate card. */
export function modelsFor(serviceKey: string): Array<Record<string, unknown>> {
  return MODEL_RATE_LIST.filter((m) => m.service === serviceKey).map((m) => ({
    model: m.model,
    rate: m.rate.toNumber(),
    per: m.unitSize ?? SERVICES[serviceKey]?.unitSize ?? 1,
  }));
}

/**
 * A JSON-serialisable description of every service and its price.
 *
 * The key names and the human-readable `pricing` string are what the public
 * pricing page renders, so this shape is fixed by the frontend rather than
 * chosen here — it matches the Python service field for field.
 */
export function rateCard(): Array<Record<string, unknown>> {
  return LIST.map((s) => ({
    service: s.key,
    label: s.label,
    unit: s.unit,
    rate: s.rate.toNumber(),
    per: s.unitSize,
    pricing:
      s.unitSize !== 1
        ? `₹${s.rateText} per ${s.unitSize} ${s.unit}`
        : // "per minute", not "per minutes" — the unit is singular here.
          `₹${s.rateText} per ${s.unit.slice(0, -1)}`,
    // Set when input and output are priced separately; `rate` above is then the
    // legacy flat rate and no longer what gets charged.
    input_rate: s.inputRate?.toNumber() ?? null,
    output_rate: s.outputRate?.toNumber() ?? null,
    // NOT `pricing` — that key already carries the human-readable price string
    // the rate card has always returned, and reusing it silently replaced it.
    pricing_mode: splitsInputOutput(s) ? 'split' : 'flat',
    // Smallest billable amount; null means exact fractions are billed.
    billing_increment: s.billingIncrement?.toNumber() ?? null,
    // Models priced differently from the service. Empty means every model on
    // this service bills at the service rate above.
    models: modelsFor(s.key),
  }));
}
