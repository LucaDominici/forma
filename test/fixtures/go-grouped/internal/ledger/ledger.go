// Package ledger keeps the double-entry book every money movement lands in.
package ledger

type Entry struct{ Cents int64 }

func Post(e Entry) error { return nil }
