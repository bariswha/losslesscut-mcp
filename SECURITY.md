# Security

## Reporting a vulnerability

Please don't open a public issue for security problems. Use GitHub's **Report a vulnerability** button on the Security tab of this repository instead.

Problems in LosslessCut itself, including its HTTP API, belong to the [LosslessCut project](https://github.com/mifi/lossless-cut).

## Design

- **Local only.** The server connects only to `127.0.0.1` on the configured port. The host is fixed in code. It makes no other network requests and has no telemetry.
- **No Origin header.** Requests never carry an `Origin` header and always use a `127.0.0.1:<port>` `Host` header, matching what LosslessCut's HTTP API accepts from local programs.
- **Allowlisted actions.** `run_action` accepts only names from a fixed list of LosslessCut keyboard actions. `quit`, `cleanupFilesDialog` (which can move source files to the trash), `openSendReportDialog`, the URL download action and the actions that take arguments are refused. Action names are also checked against `^[A-Za-z][A-Za-z0-9]*$` before they go into a URL.
- **Validated input.** Times are parsed and range-checked and sent in a fixed `hh:mm:ss.fff` format. File paths must be absolute, must point to an existing file and may not contain control characters. The assistant is told to use only paths the user gave it.
- **Bounded waits.** Every request has a timeout. Responses are capped at 1 MB.
- **Pinned CI.** The release workflow pins its actions to commit SHAs and runs the tests before publishing.

## Known limitations

- LosslessCut's HTTP API has no authentication. While LosslessCut runs with `--http-api`, any program on your computer can control it, with or without this server. Enable the API only while you need it.
- LosslessCut reports no errors over its API, so a failed action can look successful.
- `export_file` writes files where LosslessCut's export settings say, and may overwrite existing output files if LosslessCut is set to do that.
