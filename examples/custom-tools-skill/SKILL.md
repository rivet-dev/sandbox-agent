---
name: list-files
description: List files and directories at a given path inside the sandbox. Use when the user asks to browse or inspect the sandbox filesystem.
---

To list files and directories inside the sandbox, run:

```bash
node /opt/skills/list-files/list-files.cjs <path>
```

This returns one entry per line, prefixed with `d` for directories or `-` for files.
