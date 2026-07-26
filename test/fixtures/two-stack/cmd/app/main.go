package main

import (
	"fmt"

	"example.com/twostack/internal/server"
)

func main() {
	fmt.Println(server.Serve())
}
