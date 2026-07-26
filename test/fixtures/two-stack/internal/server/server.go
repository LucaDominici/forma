// Package server answers the browser the web/ stack ships.
package server

import "example.com/twostack/internal/store"

// Serve returns the payload the frontend renders.
func Serve() string { return store.Read("home") }
