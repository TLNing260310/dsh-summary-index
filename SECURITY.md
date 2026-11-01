# Security

## Trust boundary

The plugin observes committed DSH session events and writes a plugin-owned JSONL
index. It does not execute model output, shell commands, URLs, or tool calls
recovered from history. `sumidx_read` returns recorded event data only.

## Data at rest

- The index lives under `DSH_HOME/dsh-summary-index/v1` by default.
- Directory/file modes are requested as 0700/0600 where the platform honors
  them.
- The index stores bounded summary previews, anchors, source seq pointers, and
  diagnostic snippets, not complete tool output.
- Obvious tokens, JWTs, private keys, URL credentials, and password-like
  key/value pairs are redacted from stored/index-card snippets on a best-effort
  basis. This is not a substitute for a secret scanner.

## Raw event reads

`sumidx_read action=event` returns the original payload already present in the
DSH session log. That payload may contain sensitive material. Access is limited
to source/summary seqs retained by the selected index entry and requires a live
session store.

## Failure containment

Compaction observation and pre-step injection are fail-open for the host: an
index failure is logged and never prevents the already-committed compaction or
the model step. Tool name registration conflicts are intentionally fail-closed
through DSH's registry error.

## Reporting

Report security issues privately to the maintainers of the deployment that
installed this local plugin. Do not include live credentials or full session
logs in a public report.
