# How alpha does it

| id | decision | satisfies | issues |
|---|---|---|---|
| D-1 | Normalize input in the engine rather than at each call site | `R-1` | `#1` |
| D-2 | Parser errors abort the run instead of returning a partial parse | `R-2` | `#2` |
| D-3 | Route every message through one logging helper | `R-1` | `#3` |
