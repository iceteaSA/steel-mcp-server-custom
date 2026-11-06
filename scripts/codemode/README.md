# Code Mode corpus

These scripts test Steel through OpenCode and the pinned MCP hub.
Use a local-mode entry with scratch storage and `STEEL_CODE_MODE=on`.
This mode is a proposal. The current server ignores the setting.
Do not use the live Steel server or live browser storage.

`00-observe.cm` gives the values that a script receives.
`01-model-visibility.cm` reads page markers but gives only a different marker.
The `*.xfail.cm` scripts assert the proposed results and give RED results on the base.
Each first-line comment identifies the defect.
The error-code assertion also makes a hub change necessary. A server change alone cannot satisfy it.
`16-canonical-error.cm` tests the current error-code workaround.

Use the Code Mode harness with `--script FILE` for one case or `--corpus DIR` for all cases.
The harness owns the host, checks cleanup, and records the model-facing text.
Keep each script unchanged during its run.
Remove an `xfail` marker only after that assertion gives a GREEN result.
