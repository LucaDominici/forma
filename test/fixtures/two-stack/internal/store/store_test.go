package store

import "testing"

func TestRead(t *testing.T) { if Read("home") == "" { t.Fatal("missing row") } }
