# Sample tasks

Sample data for the planned sample-data extension (backlog item 9, first-run
setup). Nothing reads this folder today: the built-in sample-folder source was
removed, and the extension that will replace it isn't built yet.

The files are kept in the shape that extension is expected to read:

- **`.json`**: `{ "title": ..., "body": ..., "url": ..., "metadata": { ... } }`
- **`.txt` / `.md`**: the first non-empty line is the title, the rest is the body
