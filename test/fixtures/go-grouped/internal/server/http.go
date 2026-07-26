// Package server exposes the money domain over HTTP.
package server

import (
	"example.com/grouped/internal/account"
	"example.com/grouped/internal/ledger"
)

func Handle(id string) string { ledger.Post(ledger.Entry{}); return account.Balance(id) }
