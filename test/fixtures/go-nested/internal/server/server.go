// Package server exposes the request surface.
package server

import (
	"fmt" // stdlib — outside the module, never an edge

	"example.com/nested/internal/store"
)

// Serve handles one request by delegating to the store.
func Serve(id string) string { return fmt.Sprintf("ok:%s", store.Save(id)) }
