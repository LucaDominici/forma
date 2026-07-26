// Typed wrapper over the endpoints the Go side exposes.
export type Row = { key: string; value: string }

export const endpoint = (key: string): string => `/api/${key}`
