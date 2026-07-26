package server

import "example.com/grouped/internal/account"

func Route(id string) string { return account.Balance(id) }
