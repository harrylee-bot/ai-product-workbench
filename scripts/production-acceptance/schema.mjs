import Ajv2020 from "@redocly/ajv/dist/2020.js";

export const UTC_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/u;

export function isCanonicalUtcDateTime(value) {
  if (typeof value !== "string") return false;
  const match = value.match(UTC_DATE_TIME_PATTERN);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const daysInMonth = month === 2
    ? (isLeapYear(year) ? 29 : 28)
    : ([4, 6, 9, 11].includes(month) ? 30 : 31);
  return day >= 1 && day <= daysInMonth;
}

export function createStrictAjv2020() {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    validateFormats: true,
  });
  ajv.addFormat("date-time", {
    type: "string",
    validate: isCanonicalUtcDateTime,
  });
  return ajv;
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
