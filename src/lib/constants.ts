export const START_DATE = new Date("2026-02-08T00:00:00");

export const MY_TZ = "Africa/Cairo";
export const PARTNER_TZ = "Asia/Riyadh";

export const MY_COORDS = { lat: 30.161472, lng: 31.635861 };
export const PARTNER_COORDS = { lat: 28.3833, lng: 36.5833 };

export const MY_LABEL = "Shorouk";
export const PARTNER_LABEL = "Tabuk";

export const MY_CITY = "Al Shorouk, Egypt";
export const PARTNER_CITY = "Tabuk, KSA";

export const DISTANCE_KM = 520;

export const BIRTHDAYS = {
  me: { month: 6, day: 11, year: 1998, label: "T7SEN's Birthday" },
  partner: { month: 6, day: 4, year: 2009, label: "Besho's Birthday" },
};

/**
 * The next planned visit date. Set to null when no date is confirmed.
 * Update this value in constants.ts whenever a visit is planned.
 */
export const NEXT_VISIT_DATE: Date | null = null;
