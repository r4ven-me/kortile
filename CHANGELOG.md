# Changelog

## Unreleased

### Fixed

- Reloading the applet ("Restart Kortile", Cinnamon's own Reload, or
  removing it from the panel) no longer leaves the old instance running
  in the background. Its untracked-window sweep kept re-tracking and
  retiling windows every 3 s, fighting the new instance for them.
- Pending floating-size saves and per-window `size-changed` handlers are
  now cleaned up on reload too.
- The "Alt + drag", "Focus follows mouse" and "auto-raise" toggles no
  longer overwrite the system window preferences every time the applet
  starts. Before, a fresh install cleared Cinnamon's own Alt+drag
  modifier and forced focus mode to "click". The toggles now only touch
  those preferences when you flip them, and turning one off restores
  the value you had before turning it on.
- "Pick a window..." in Settings no longer picks minimized windows or
  windows on other workspaces.
- Removed leftover debug logging, which wrote window titles to
  `~/.xsession-errors` on every window creation and geometry change.

### Changed

- `metadata.json` sets `"max-instances": 1`, so Cinnamon itself stops a
  second copy from being added to a panel.
- `make spice-sync` no longer ships the `*.test.js` files to Spices.
- `make release` commits only files git already tracks (and lists any
  untracked ones) instead of `git add -A`.

## 1.0.0

- Initial release.
