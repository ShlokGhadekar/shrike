# @shrike/redact

Removes secrets before anything is stored, shown, sent to an agent or exported. Runs on ingest, on every MCP tool output, and on export.

Rules and order: [docs/07-security-privacy.md](../../docs/07-security-privacy.md#redaction-rules-shrikeredact).

```
src/
└── index.ts       # redactText, redactEvent, redactCell, redactRow, entropy: key patterns, known secret shapes, high-entropy strings, user rules
                   # maskValues, maskAction, maskText: value masking where a live trip leaves the screen (#52)
```

Every rule has a `node:test` check with a positive and a negative sample. Changes here need review.
