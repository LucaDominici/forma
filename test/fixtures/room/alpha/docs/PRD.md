# What alpha must do

| id | requirement | verified by |
|---|---|---|
| R-1 | Trim what the user typed before acting on it | `npm test` |
| R-2 | Say what went wrong when parsing fails | `npm test` |

| feature | use_case | test | execution | verdict | requirement |
|---|---|---|---|---|---|
| — | UC-1 | `npm test` | 39/39 | PASS | R-1 |
| F-2 | — | `npm test` | 39/39 | PASS | R-1 |
