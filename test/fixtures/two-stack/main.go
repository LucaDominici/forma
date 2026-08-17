package twostack

import "example.com/twostack/internal/server"

func Root() string { return server.Serve() }
