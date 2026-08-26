export function formatAmerican(odds: number): string {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

export function formatPercent(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

export function formatSignedPercent(p: number): string {
  const formatted = formatPercent(Math.abs(p));
  return p >= 0 ? `+${formatted}` : `-${formatted}`;
}

export function formatLine(line: number): string {
  return line > 0 ? `+${line}` : `${line}`;
}

export function formatMoney(amount: number): string {
  const abs = Math.abs(amount).toFixed(2);
  return amount < 0 ? `-$${abs}` : `$${abs}`;
}

export function formatSignedMoney(amount: number): string {
  return amount >= 0 ? `+${formatMoney(amount)}` : formatMoney(amount);
}
