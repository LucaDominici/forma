package store

import "testing"

func TestSave(t *testing.T) {
	if Save("x") != "x" {
		t.Fatal("Save lost the id")
	}
}
