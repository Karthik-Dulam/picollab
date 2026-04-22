# picollab

A pi package that watches git-tracked files for changes made outside pi and injects those changes back into the active session as edit-style diffs.

## Install

```bash
pi install git:github.com/Karthik-Dulam/picollab
```

Or try it without installing:

```bash
pi -e git:github.com/Karthik-Dulam/picollab
```

## What it does

- watches the current git repo for changes to tracked files
- ignores pi's own file mutations from `edit`, `write`, and `bash`
- emits an `external edit` message in the transcript
- renders the diff in an edit-like style in the TUI
- injects explicit context like:

````text
External file change detected in app.txt:

```text
 1 alpha
-2 beta
+2 BETA
```
````

## Commands

```text
/external-watch status
/external-watch on
/external-watch off
/external-watch rescan
```

## Layout

- package extension: `extensions/external-edit-watch/index.ts`
- local project shim: `.pi/extensions/external-git-watch/index.ts`
