package store

// Keys lists every row the store holds.
func Keys() []string {
	out := []string{}
	for k := range rows {
		out = append(out, k)
	}
	return out
}
