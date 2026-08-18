# How alpha does it

| id | decision | satisfies | issues |
|---|---|---|---|
| D-1 | Normalize input in the engine rather than at each call site | `R-1` | `#1` |
| D-2 | Parser errors abort the run instead of returning a partial parse | `R-2` | `#2` |
| D-3 | Route every message through one logging helper | `R-1` | `#3` |

| id | capability | status | issue_ref | code_ref | release | feature_ids |
|---|---|---|---|---|---|---|
| F-1 | Normalize input once | In delivery | `#1` | `src/core/engine.js` | v1 | — |
| F-2 | Log through one helper | Released | `#3` | `src/util/log.js` | v1 | — |
| UC-1 | Enter whitespace-padded input | Released | — | `src/core/engine.js` | v1 | F-1 |
