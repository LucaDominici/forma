// Package account owns the customer accounts and what each one is worth.
package account

import (
	"fmt"

	"example.com/grouped/internal/ledger"
)

func Balance(id string) string { ledger.Post(ledger.Entry{}); return fmt.Sprint(id) }
