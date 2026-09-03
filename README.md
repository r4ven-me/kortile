# Kortile

By Ivan Cherniy. Dynamic master-slave window tiling for the Cinnamon
desktop, a Cinnamon **panel applet** (GJS, uses Muffin's own `Meta.Window`
API) that works unchanged on both X11 and Wayland Cinnamon sessions. It's an
applet rather than a headless extension specifically so it shows a panel
icon with a menu (toggle, layout picker, master/slave, restore, reset) - the
Cinnamon equivalent of a systray icon.

## Install

```bash
mkdir -p ~/.local/share/cinnamon/applets

git clone https://github.com/r4ven-me/kortile.git ~/.local/share/cinnamon/applets/kortile@r4ven.me
```

Then add it to a panel via *Cinnamon Settings → Applets → "+"*, or right-click
the panel → *Add applets to the panel*. Configure it from the same Applets
page ("Configure" gear icon): General/Geometry, Window Rules, and Keyboard
Shortcuts pages.

The panel icon's menu: enable/disable tiling, pick a layout, add/remove a
master, show one more/less slave, restore windows to their pre-tiling
geometry (and stop tiling them), reset the layout, or "Restart Kortile"
(reloads the applet in place, same as Cinnamon's own "Reload" - also handy
any time a window seems to have drifted out of tracking).

## Features

- **Layouts**: vertical-left, vertical-right, horizontal-top,
  horizontal-bottom, maximized. Per (workspace, monitor) tiling state, with
  an adjustable master/slave ratio. Optionally remembered across restarts
  per (workspace, monitor) - off by default, since it's the kind of thing
  you want to opt into rather than be surprised by.
- **Master/slave counts**: configurable master count and visible-slave
  count; extra windows beyond the visible count round-robin onto the
  existing slots.
- **Window tabs**: when several windows of the same app round-robin into
  one slot, an optional small strip of buttons appears above it so you can
  see and switch between them, instead of them silently stacking. Configurable:
  minimum window count before it shows, icons-only vs. icons-with-titles,
  left/center/right position, custom colors. Tabs can be renamed
  (double-click, icons-with-titles style) and dragged to reorder;
  middle-click closes a tab's window. Strips stay out of the way of the
  panel, Cinnamon's overview, and any window they don't manage that happens
  to overlap them (a floating window, a drop-down terminal like Guake, ...).
  A minimized window keeps its tab (click to restore it) rather than
  disappearing from the strip - it's not tiled while minimized (nothing
  to switch away from), but the strip still remembers which slot it
  belongs to.
- **Auto-tiling**: new/closed/minimized windows, and windows moved across
  monitors/workspaces, are tracked automatically. A low-frequency sweep
  also catches any window that was eligible but somehow missed at the
  moment it was created (some apps briefly hold a state - e.g. a
  transient parent - that clears a moment later, with nothing else left
  to re-check it once that first chance has passed).
- **Mouse control**: drag a tile's edge to resize the master/slave split or
  the boundary between stacked windows; drag one tiled window onto another
  to swap their slots; drag across a monitor/workspace boundary to move a
  window there. Optional "Alt + drag to move/resize" toggle (flips
  Cinnamon's own built-in Muffin feature).
- **Keyboard control**: full shortcut set for layout, master/slave counts,
  proportions, window focus/swap, and floating - all via Cinnamon's own
  keybinding widgets.
- **Stubborn-app handling**: a few apps snap themselves back to their own
  preferred geometry after being tiled; kortile keeps re-asserting the tile
  slot rather than losing that fight, and clips window content to its slot
  in the meantime so nothing visually spills into a neighboring tile.
- **Animated moves**: retiled windows slide into place instead of jumping.
  A window already sitting exactly where a retile would put it again is
  left alone rather than repositioned redundantly - noticeable switching
  focus into a slot several windows deep, where a retile otherwise touched
  every one of them just to re-check which app's tab strip should show.
- **Focus border**: a configurable-color/width outline around the focused
  window, for apps with no border of their own; hidden in maximized layout
  by default (optional) and for genuinely fullscreen windows.
- **Focus-follows-mouse / auto-raise / raise delay**: optional toggles,
  flip the matching built-in Cinnamon/Muffin window preferences.
- **Floating**: pull a window out of the grid to move/resize it freely
  without touching its neighbors' layout; toggle it back to re-tile.
- **Window ignore rules**: regex on class/title, editable from Settings,
  plus a "pick a window to exclude" button.
- **Startup workspace rules**: move new windows matching a class/title
  pattern to a given workspace as soon as they open.
- **Fullscreen/maximize**: a tiled window going fullscreen or clicking its
  native maximize button is left alone for as long as that lasts, then
  re-tiled once it exits.
- **Panel icon + menu**: toggle tiling, pick a layout, add/remove a master,
  show more/fewer slaves, restore windows to their pre-tiling geometry,
  reset the layout, or reload the applet.
- Settings UI generated by Cinnamon's own `settings-schema.json` mechanism
  (no hand-rolled GTK).

## Known platform quirks

- Some apps enforce a minimum window size (e.g. KeePassXC). When a tile slot is
  smaller than that minimum, Mutter clamps the size to the minimum rather than the
  computed slot size - the slot's Clutter clip still crops it to the intended
  bounds, so it won't visually overlap its neighbor, but its content will look
  cropped instead. This is inherent to those apps, not a bug in the tiling math.
- Only one instance of this applet should be added to a panel - it manages
  window state for the whole desktop, not per-instance. Running it alongside
  a standalone X11 tiling tool at the same time will make them fight over
  the same windows; use one or the other per session, not both.

## Author

Ivan Cherniy.

## License

GPL-3.0 - see [LICENSE](LICENSE).
