// Package worker runs the overnight jobs nobody watches.
package worker

import "example.com/grouped/internal/account"

func Nightly() string { return account.Balance("all") }
