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

`security/` tests page-chosen URL fields with a local HTTP fixture.
`fixture-entry.ts` owns that fixture and the local Steel child process.
Its port comes from `CM_FIXTURE_PORT`. `CM_STEEL_BUILD` selects the built server.
Replace `__FIXTURE_ORIGIN__` with the local fixture URL before the run.
The harness checks that the fixture and browser processes stop at teardown.
