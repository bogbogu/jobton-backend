const CURRENCY_SYMBOLS = {
  NGN: "₦",
  USD: "$",
};

const numberFormatter = new Intl.NumberFormat("en-US");

export const formatSalaryDisplay = ({ salaryMin, salaryMax, salaryCurrency, salaryPeriod }) => {
  // Ingested jobs often don't state pay (or the pay period).
  if (salaryMin === undefined || salaryMin === null) {
    return "Not specified";
  }

  const symbol = CURRENCY_SYMBOLS[salaryCurrency] || "";
  const min = `${symbol}${numberFormatter.format(salaryMin)}`;
  const suffix = salaryPeriod ? ` / ${salaryPeriod}` : "";

  if (salaryMax && salaryMax > salaryMin) {
    const max = `${symbol}${numberFormatter.format(salaryMax)}`;
    return `${min} – ${max}${suffix}`;
  }

  return `${min}${suffix}`;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export const formatRelativeDate = (date) => {
  const now = new Date();
  const target = new Date(date);

  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((startOfDay(now) - startOfDay(target)) / DAY_MS);

  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return `${diffDays} days ago`;
};

export const formatLongDate = (date) => {
  return new Date(date).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
};
