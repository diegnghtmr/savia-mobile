import { ACTIVE_CURRENCIES } from "./currencies";
export class InvalidDraft extends Error {}
export const workspaceUnavailable = "Este espacio ya no está disponible.";

const countries = new Set("AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(" "));
const dates = ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"];
const numbers = ["1,234.56", "1.234,56"];
const onboardingFields = ["email", "displayName", "locale", "countryCode", "timezone", "dateFormat", "weekStartsOn", "numberFormat", "defaultCurrency", "workspaceName", "baseCurrency"];

export function validEmail(value: string) {
  return value.length <= 254 && value.indexOf("@") <= 64 && /^[A-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?$/i.test(value);
}

function fields(input: unknown, keys: string[]): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== keys.length) throw new TypeError();
  return Object.fromEntries(keys.map((key) => {
    const value = (input as Record<string, unknown>)[key];
    if (!Object.hasOwn(input, key) || typeof value !== "string" || value.includes("\0") || !value.trim()) throw new TypeError();
    return [key, value.trim()];
  }));
}

function name(value: string) {
  if ([...value].length > 120) throw new TypeError();
  return value;
}

function currency(value: string) {
  const code = value.toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new TypeError();
  const known = ACTIVE_CURRENCIES.has(code);
  if (!known) throw new TypeError();
  return code;
}

export function onboardingDraft(input: unknown) {
  try {
    const data = fields(input, onboardingFields);
    const locale = Intl.DateTimeFormat.supportedLocalesOf([data.locale])[0];
    const timezone = Intl.DateTimeFormat("en", { timeZone: data.timezone }).resolvedOptions().timeZone;
    const countryCode = data.countryCode.toUpperCase();
    if (!validEmail(data.email) || !locale || !countries.has(countryCode) || !dates.includes(data.dateFormat) || !numbers.includes(data.numberFormat) || !/^[0-6]$/.test(data.weekStartsOn)) throw new TypeError();
    return { email: data.email.toLowerCase(), displayName: name(data.displayName), locale, countryCode, timezone,
      dateFormat: data.dateFormat, weekStartsOn: Number(data.weekStartsOn), numberFormat: data.numberFormat,
      defaultCurrency: currency(data.defaultCurrency), workspaceName: name(data.workspaceName), baseCurrency: currency(data.baseCurrency) };
  } catch { throw new InvalidDraft("Revisa los datos de tu perfil."); }
}

export function recoveryDraft(input: unknown) {
  try {
    const data = fields(input, ["name", "baseCurrency"]);
    return { name: name(data.name), baseCurrency: currency(data.baseCurrency) };
  } catch { throw new InvalidDraft("Revisa el nombre y la moneda base del espacio."); }
}
