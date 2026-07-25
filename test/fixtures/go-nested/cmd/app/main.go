// Package main wires the binary. Single-line import form on purpose.
package main

import "example.com/nested/internal/server"

func main() { println(server.Serve("1")) }
