/** First day of the UTC calendar month containing `now`, formatted YYYY-MM-01. */
export function utcPeriodStart(now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}
