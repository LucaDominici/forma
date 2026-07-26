package store

// Query is a second non-test file, so the package's file count is not trivially 1 —
// without it the drift assertion could not tell a real count from a hardcoded one.
func Query() string { return "q" }
