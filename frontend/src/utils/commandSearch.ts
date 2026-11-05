/**
 * Whether a command-search entry is a sum for the calculator (Mule City, MuleCity-1ptj).
 *
 * "=" always calculates. Otherwise only arithmetic with a +, *, / or % operator is a sum:
 * "(919) 555-1234", "919-555-1234", "9195551234" and "1234" are phone numbers to search
 * for. Subtraction alone reads as a phone number, so "=55-45" calculates it.
 */
export function isCalculation(term: string): boolean {
	const value = term.trim();
	if (value.startsWith("=")) return true;
	return /^[\d\s+\-*/().%]+$/.test(value) && /\d\s*[+*/%]\s*[\d(]/.test(value);
}
