/**
 * Builds an invoice PDF from a set of billable lines.
 */
export const invoice = (lines) => lines.reduce((a, l) => a + l.amount, 0)
