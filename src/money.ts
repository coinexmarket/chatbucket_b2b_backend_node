/**
 * Money handling — exact decimal amounts, in one place.
 *
 * Ported from `app/money.py`, and the single riskiest part of this port.
 * Python has exact decimals natively; JavaScript has only float64, where
 * `0.1 + 0.2 === 0.30000000000000004`. That error compounds the moment Mongo
 * `$sum`s thousands of usage rows into an invoice total.
 *
 * So amounts move through three representations and this module owns the edges:
 *
 *   - `Decimal`    (decimal.js) — arithmetic;
 *   - `Decimal128` (bson)       — storage, which Mongo's `$sum` adds exactly;
 *   - `number`                  — the JSON wire, and *only* there.
 *
 * **Nothing outside this module may call `Number()` on an amount.** If you find
 * yourself wanting to, you want `toJson` and you are about to introduce a
 * rounding bug in billing.
 */
import { Decimal128 } from 'mongodb';
import Decimal from 'decimal.js';

// Sub-paisa precision: 1 unit = ₹0.0001. The rate card is priced to 4dp, so
// this is what every stored cost is rounded to.
export const DECIMAL_PLACES = 4;
const PAISE_PLACES = 2;

// Half-up is what an invoice reader expects. decimal.js defaults to half-up
// already (ROUND_HALF_UP = 4), but it is set explicitly because the default is
// global mutable state that another import could change under us.
Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_UP });

export type Money = Decimal;
export type AmountLike = Decimal | Decimal128 | number | string;

/**
 * Coerce an amount from any layer into a `Decimal`.
 *
 * Numbers convert via `String` on purpose: that yields the shortest decimal
 * which reads back as the same float (`0.1` -> `"0.1"`) rather than the exact
 * binary expansion. This is also the path that reads usage records written
 * before costs were stored as `Decimal128`.
 */
export function toDecimal(value: AmountLike): Decimal {
  if (value instanceof Decimal) return value;
  if (value instanceof Decimal128) return new Decimal(value.toString());
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Not a usable amount: ${value}`);
    return new Decimal(String(value));
  }
  return new Decimal(value);
}

/**
 * Round to the currency's 4dp, half-up.
 *
 * Half-up because an invoice reader expects it. Banker's rounding would turn
 * ₹0.00005 into ₹0.0000 and read as a bug to the customer.
 */
export function quantize(amount: AmountLike): Decimal {
  return toDecimal(amount).toDecimalPlaces(DECIMAL_PLACES, Decimal.ROUND_HALF_UP);
}

/** Render an amount for storage, quantized to the currency's precision. */
export function toBson(amount: AmountLike): Decimal128 {
  return Decimal128.fromString(quantize(amount).toFixed(DECIMAL_PLACES));
}

/**
 * Render an amount for the JSON wire. The one sanctioned float conversion.
 *
 * JSON has no decimal type and every client parses numbers as float64 anyway,
 * so precision beyond this point is not ours to keep. Lossless in practice:
 * float64 carries ~15 significant digits, and a 4dp amount only exhausts that
 * past ₹10 billion.
 */
export function toJson(value: AmountLike): number {
  return quantize(value).toNumber();
}

/** Round an amount to whole paise, half-up — what a gateway can charge. */
export function toChargeable(amount: AmountLike): Decimal {
  return toDecimal(amount).toDecimalPlaces(PAISE_PLACES, Decimal.ROUND_HALF_UP);
}

/**
 * Render an amount as whole paise, for a payment gateway.
 *
 * Throws rather than rounding: charging ₹100.56 for a ₹100.5551 order would make
 * the money taken differ from the money recorded, which is the one thing
 * billing must never do. Call `toChargeable` first if you need it rounded.
 */
export function toPaise(amount: AmountLike): number {
  const value = toDecimal(amount);
  const paise = value.times(100);
  if (!paise.isInteger()) {
    throw new Error(
      `${value.toString()} is not a whole number of paise and cannot be charged exactly.`,
    );
  }
  return paise.toNumber();
}

/** Sum amounts exactly, quantized once at the end. */
export function total(amounts: Iterable<AmountLike>): Decimal {
  let acc = new Decimal(0);
  for (const a of amounts) acc = acc.plus(toDecimal(a));
  return quantize(acc);
}

export { Decimal };
