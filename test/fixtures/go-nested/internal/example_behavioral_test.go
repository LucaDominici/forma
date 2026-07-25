package internal_test

// The ONE .go file sitting directly in internal/ — and it is a test. This is what made forma
// stop at `internal` and seed it as a single container, hiding every package underneath.

import "testing"

func TestBehaviour(t *testing.T) { _ = t }
