# YouTube Tuner — Session Diagnostic Format

Exported via the `*` button in the HUD. One file per export, downloaded as
`yt-tuner-diag-<context>-<timestamp>.md`. Structured for machine reading.

---

## Header

```
session_id: <integer>
exported_at: <ISO 8601>
page_context: home | search | other
scan_count: <integer>
nuke_count: <integer>
```

---

## Filters

One row per heuristic. State is session-only.

```
| filter  | enabled | caught |
|---------|---------|--------|
| PHRASE  | yes/no  | <n>    |
| SLOP    | yes/no  | <n>    |
| CAPS    | yes/no  | <n>    |
| DUPE    | yes/no  | <n>    |
| WATCHED | yes/no  | <n>    |
```

---

## Custom Phrases

Persistent. Empty section if none set.

```
- <phrase>
- <phrase>
```

---

## Nuke Log

Last 5 confirmed-nuked titles (most recent first). Persisted across sessions.

```
1. [REASON] title text
2. [REASON] title text
...
```

---

## System Events

All WARN and CRIT entries logged this session, in order. Omit INFO.

```
[WARN] message
[CRIT] message
```

---

## Notes

- Do not include individual INFO entries — they are noise at this level.
- CRIT entries must always appear, even if the section would otherwise be empty.
- If no system events occurred, write `none`.
