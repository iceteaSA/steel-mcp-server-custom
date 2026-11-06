# Code Mode corpus

These scripts test Steel through OpenCode and the pinned MCP hub.
Use a local-mode entry with scratch storage and `STEEL_CODE_MODE=on`.
The main directory tests caller lanes. `off/` tests `STEEL_LANES=off`.
`default/` tests the unchanged default output with `STEEL_CODE_MODE=off` in each lane mode.
Do not use the live Steel server or live browser storage.

`00-observe.cm` gives the values that a script receives.
`01-model-visibility.cm` reads page markers but gives only a different marker.
The RED commit records the initial defects as `*.xfail.cm` scripts.
The active scripts assert raw identifiers and fenced free text.
`known-hub/` keeps the typed-error defect as an `xfail` case.
A hub change is necessary for that assertion. A server change alone cannot satisfy it.
`16-canonical-error.cm` tests the current error-code workaround.

Use the Code Mode harness with `--script FILE` for one case or `--corpus DIR` for all cases.
The harness owns the host, checks cleanup, and records the model-facing text.
Keep each script unchanged during its run.
Remove an `xfail` marker only after that assertion gives a GREEN result.
