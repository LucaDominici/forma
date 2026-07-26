// Package store keeps the rows the server hands out.
package store

var rows = map[string]string{"home": "hello"}

// Read returns the row under key, or the empty string.
func Read(key string) string { return rows[key] }
