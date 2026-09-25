# Changelog

## Unreleased

### Added

- Window tabs: one shared strip per workspace/monitor covering every
  window there (split at the master/slave gap in vertical layouts), with
  equal-width tabs and ellipsized titles.
- Option to include floating/ignored windows in the tab strip.
- Tab icon size and title font size settings.
- An automatic list of minimized windows when every tiled window on a
  workspace/monitor is minimized (can be turned off).

### Removed

- Tab settings "Tab grouping", minimum window count, strip position and
  "Stretch tab strip" (the strip now always spans the tiled area).

### Changed

- Focus border moved into its own `focus-border.js`.

### Fixed

- The automatic minimized-window list no longer stays on screen after
  switching to another workspace, or over the overview/expo.

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
- `make spice-sync` no longer ships the `*.test.js` files to Spices, and
  rebuilds the applet folder in the fork from scratch so removed files
  (e.g. the old `tabs.js`) don't linger there.
- `make release` commits only files git already tracks (and lists any
  untracked ones) instead of `git add -A`.

## 1.0.0

- Initial release.
