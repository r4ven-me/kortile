const Applet = imports.ui.applet;
const Main = imports.ui.main;
const Meta = imports.gi.Meta;
const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Settings = imports.ui.settings;
const PopupMenu = imports.ui.popupMenu;
const ExtensionSystem = imports.ui.extension;
const Tooltips = imports.ui.tooltips;
const Cinnamon = imports.gi.Cinnamon;

const { Manager, LAYOUTS, shrink } = require("./manager");
const { computeWindowTabStripX } = require("./tabs");

const KEYBINDINGS = [
    { key: "kb-toggle", prop: "kbToggle", action: "toggle" },
    { key: "kb-cycle-next", prop: "kbCycleNext", action: "cycle-next" },
    { key: "kb-cycle-previous", prop: "kbCyclePrevious", action: "cycle-previous" },
    { key: "kb-layout-vertical-left", prop: "kbLayoutVerticalLeft", action: "layout-vertical-left" },
    { key: "kb-layout-vertical-right", prop: "kbLayoutVerticalRight", action: "layout-vertical-right" },
    { key: "kb-layout-horizontal-top", prop: "kbLayoutHorizontalTop", action: "layout-horizontal-top" },
    { key: "kb-layout-horizontal-bottom", prop: "kbLayoutHorizontalBottom", action: "layout-horizontal-bottom" },
    { key: "kb-layout-maximized", prop: "kbLayoutMaximized", action: "layout-maximized" },
    { key: "kb-master-increase", prop: "kbMasterIncrease", action: "master-increase" },
    { key: "kb-master-decrease", prop: "kbMasterDecrease", action: "master-decrease" },
    { key: "kb-slave-increase", prop: "kbSlaveIncrease", action: "slave-increase" },
    { key: "kb-slave-decrease", prop: "kbSlaveDecrease", action: "slave-decrease" },
    { key: "kb-window-next", prop: "kbWindowNext", action: "window-next" },
    { key: "kb-window-previous", prop: "kbWindowPrevious", action: "window-previous" },
    { key: "kb-master-make", prop: "kbMasterMake", action: "master-make" },
    { key: "kb-toggle-floating", prop: "kbToggleFloating", action: "toggle-floating" },
    { key: "kb-proportion-increase", prop: "kbProportionIncrease", action: "proportion-increase" },
    { key: "kb-proportion-decrease", prop: "kbProportionDecrease", action: "proportion-decrease" },
    { key: "kb-stack-proportion-increase", prop: "kbStackProportionIncrease", action: "stack-proportion-increase" },
    { key: "kb-stack-proportion-decrease", prop: "kbStackProportionDecrease", action: "stack-proportion-decrease" },
    { key: "kb-restore", prop: "kbRestore", action: "restore" },
    { key: "kb-reset", prop: "kbReset", action: "reset" },
    { key: "kb-minimized-switcher", prop: "kbMinimizedSwitcher", action: "minimized-switcher" },
];

const LAYOUT_LABELS = {
    "vertical-left": "Vertical - master left",
    "vertical-right": "Vertical - master right",
    "horizontal-top": "Horizontal - master top",
    "horizontal-bottom": "Horizontal - master bottom",
    maximized: "Maximized",
};

// Fallbacks only - color/width are normally read live from
// focusBorderColor/focusBorderWidth (Settings), see _applyFocusBorderStyle.
const FOCUS_BORDER_COLOR_DEFAULT = "#ff8800";
const FOCUS_BORDER_WIDTH_DEFAULT = 3;

// See _reserveWindowTabSpace/_syncWindowTabStrips - height reserved above a
// slot for the strip, and the icon size within each tab button.
// WINDOW_TAB_BUTTON_PADDING is deliberately generous (not just enough to
// clear the icon) - confirmed live that a tighter padding made the
// clickable area feel like it was only the icon glyph itself: a click a
// few px off the icon (well within the button's own actual bounds, which
// *did* register correctly) still felt like a miss with nothing to show
// where the real edge was, since an unstyled St.Button has no visible
// boundary of its own at rest. The always-on (not just on
// hover/focus) background in _restyleWindowTabButton is the other half of
// the same fix - showing the real clickable bounds, not just enlarging
// them.
// Confirmed live this needs to actually match the strip's own real
// rendered height (from WINDOW_TAB_ICON_SIZE/WINDOW_TAB_BUTTON_PADDING
// below plus the strip's own padding) - it used to just be a guess (28)
// short of the true value (34px in "Icons with titles" style, whose label
// is taller than the icon; 30px in icons-only), so the strip's own bottom
// few px sat *inside* where a tiled window's frame began instead of
// strictly above it, letting the focus border's own top edge (see
// _updateFocusBorder) land inside the strip's real bounds even after
// accounting for the border's own outset. Matches the taller ("Icons with
// titles") case so both styles always have at least enough room, not
// exactly the same room.
const WINDOW_TAB_STRIP_HEIGHT = 34;
const WINDOW_TAB_ICON_SIZE = 16;
const WINDOW_TAB_BUTTON_PADDING = 5;
const WINDOW_TAB_TITLE_MAX_CHARS = 28;
// Below this, a press+release is a click (or the second half of a
// double-click); at or past it, see _startWindowTabDrag instead - a plain
// click's own small amount of incidental pointer jitter between press and
// release should never be misread as the start of a drag.
const WINDOW_TAB_DRAG_THRESHOLD = 6;

// Minimized-window switcher (see _openMinimizedSwitcher) - a row's icon is
// deliberately bigger than a tab button's (WINDOW_TAB_ICON_SIZE) since this
// popup has no strip slot height to stay within, and title/tooltip aren't
// the only way to read a row here the way they are for icons-only tabs.
const MINIMIZED_SWITCHER_ICON_SIZE = 24;
const MINIMIZED_SWITCHER_ROW_PADDING = 6;
const MINIMIZED_SWITCHER_MIN_WIDTH = 260;

// Fallback for the tab strip's own background (see _windowTabBackgroundColor)
// when a real theme-derived color isn't available - Nord's "nord1" polar
// night tone (https://www.nordtheme.com/), the same value window-tabs-
// background-color's own schema default already uses. Plain hex (not a
// pre-built rgba() string) so _windowTabBackgroundColor can run it through
// hexToRgba with whichever alpha windowTabsOpaque calls for, same as the
// other two branches there.
const WINDOW_TAB_BACKGROUND_FALLBACK_HEX = "#3b4252";

// Window types a focused window actually looks like "a window" for border
// purposes - a right-click context menu becoming global.display.focus_window
// (confirmed live: Telegram's own context menu reports as OVERRIDE_OTHER
// while focused) shouldn't get outlined just because it briefly held focus,
// same for any other transient menu/tooltip/dnd-icon type. DIALOG/MODAL_DIALOG/
// UTILITY are kept since those are genuine windows a user works in (a "Save
// As" dialog, a tool palette), same as any other floating window.
const FOCUS_BORDER_WINDOW_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.UTILITY,
];

function rectFromMeta(r) {
    return { x: r.x, y: r.y, w: r.width, h: r.height };
}

// GTK's colorchooser setting type (see window-tabs-background-color/
// -foreground-color) hands back "#rrggbb" only for the schema's own
// default value - the moment the user actually picks a color in the
// real GTK color dialog, Cinnamon persists it as "rgb(r, g, b)" instead
// (same format focus-border-color gets, but that one is fed straight
// into CSS as a bare color so it never needed parsing). This builds the
// rgba() strings the tab strip needs for its own translucent layers,
// which neither of those input formats can express on their own, so it
// has to accept both.
function hexToRgba(color, alpha) {
    const str = color || "";
    const rgbMatch = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (rgbMatch) {
        const [, r, g, b] = rgbMatch;
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    // Neither of the two formats above is ever shorthand, but a hand-edited
    // config.json could still hold "#rgb" - expand it before parsing so that
    // doesn't silently fall back to white too.
    let clean = str.replace("#", "");
    if (clean.length === 3) clean = [...clean].map((c) => c + c).join("");
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return `rgba(255, 255, 255, ${alpha})`;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

class KortileApplet extends Applet.IconApplet {
    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.uuid = metadata.uuid;

        this._managers = new Map(); // "wsIndex:monIndex" -> Manager
        this._originalGeometry = new Map(); // Meta.Window -> {x,y,w,h}
        this._windowSignals = new Map(); // Meta.Window -> [signal ids]
        this._lastAppliedRect = new Map(); // Meta.Window -> {x,y,w,h}, last geometry *we* applied
        // Meta.Window -> {x,y,w,h}, last geometry we *asked for* - tracked
        // separately from _lastAppliedRect (what actually landed) so
        // _applyOne's own short-circuit can tell "nothing changed, skip"
        // apart from "still asking for the same thing an app's own size
        // hints won't let it fully honor" (see there) - those aren't the
        // same thing for e.g. a window whose resize increments quantize it
        // a few px short of whatever exact pixel size it's asked for.
        this._lastRequestedRect = new Map();
        this._geometryDebounce = new Map(); // Meta.Window -> GLib timeout id, see _onWindowGeometryChanged
        this._releasePoll = new Map(); // Meta.Window -> GLib timeout id, see _pollForDragRelease
        this._stubbornCount = new Map(); // Meta.Window -> consecutive resist-the-tile count, see _commitGeometryChange
        this._dragFlag = new Map(); // Meta.Window -> true if a mouse button was held at any point during the current unsettled geometry burst, see _onWindowGeometryChanged
        this._enforceTimers = new Map(); // Meta.Window -> GLib timeout id, periodic re-assertion for windows that resist tiling with no user input involved, see _startEnforcing
        this._clipGeneration = new Map(); // Meta.Window -> integer, guards a stale _applyClipWhenSettled poll from clobbering a newer _applyOne call's clip, see _applyOne
        this._floatingWindows = new Set(); // Meta.Window -> explicitly untiled via kb-toggle-floating, see _toggleFloating
        // Meta.Window -> currently untiled specifically because the user
        // native-maximized (or fullscreened) an already-tiled window, see
        // _onWindowMaximizedChanged/_onWindowFullscreenChanged. Same idea as
        // _floatingWindows - keeps _isTileable() saying no for it - but
        // scoped separately since it's cleared automatically the moment the
        // window un-maximizes/un-fullscreens rather than needing an explicit
        // user toggle back. Without this, _startUntrackedWindowSweep's own
        // periodic re-check (every 3s, see there) has no way to tell "still
        // deliberately maximized" apart from "eligible but somehow missed at
        // creation", and silently re-tracks (and so un-maximizes, see
        // _commitGeometryChange) it the next time it happens to run - this is
        // the fix for a maximized tiled window reverting to its tile on its
        // own a few seconds after the maximize button is clicked.
        this._nativeMaximizedWindows = new Set();
        this._minimizedWindowManager = new Map(); // Meta.Window -> Manager it was tiled in right before minimizing, see _onWindowMinimizedChanged/_reserveWindowTabSpace
        // Meta.Window -> {mg, info} it was removed from ({kind, index}, see
        // manager.js removeWindow/restoreWindow) right before a *temporary*
        // removal - minimizing, native maximize/fullscreen, explicit float.
        // _trackWindow consumes this on the way back in so the window lands
        // back near its old slot via restoreWindow() instead of jumping to
        // the front the way a plain addWindow() would (see _trackWindow) -
        // this is the fix for restoring a minimized window (e.g. via the
        // taskbar/grouped window list) landing it, and shifting every other
        // window along with it, at the front slot instead of back where it
        // came from.
        this._removedWindowPosition = new Map();
        this._pendingTrack = new Set(); // Meta.Window -> created but not tracked yet, see _onWindowCreated
        this._floatingWindowSizes = new Map(); // wm_class -> {w,h}, see remember-floating-window-size-enabled
        this._floatingSizeDebounce = new Map(); // wm_class -> GLib timeout id, see _onFloatingWindowSizeChanged
        this._workspaceSwitchRetileId = null; // GLib timeout id, see _onWorkspaceSwitched
        this._globalSignals = [];
        this._kbNames = [];
        this._retiling = false; // re-entrancy guard, see _retile()

        this._focusBorderWin = null; // Meta.Window currently outlined, if any
        this._focusBorderSignalIds = []; // signal ids connected on _focusBorderWin for live repositioning, see _onFocusWindowChanged
        this._focusBorder = new St.Bin({ style_class: "kortile-focus-border", reactive: false });
        Main.uiGroup.add_actor(this._focusBorder);
        // Pin it directly above the window layer (global.window_group is
        // Main.uiGroup's own bottommost child - every other actor there is
        // some kind of chrome: panels, menus, notifications, OSDs...) so it
        // renders over the focused window but never over any of that.
        // Plain add_actor() alone leaves it wherever it happens to land in
        // uiGroup's sibling order at whatever point kortile itself got
        // added there - confirmed live that can and does end up *above*
        // various chrome (kortile's own panel menu the first time this was
        // reported, then a right-click desktop/panel menu next), since
        // nothing else ever revisits that position afterward.
        Main.uiGroup.set_child_above_sibling(this._focusBorder, global.window_group);
        this._focusBorder.hide();

        this._windowTabGroups = new Map(); // groupKey ("ws:mon:rectKey:wmClass") -> {actor, buttons: Map<Meta.Window, St.Button>}, see _syncWindowTabStrips
        this._windowTabCustomNames = new Map(); // Meta.Window -> string, user-set via double-click rename, see _startWindowTabRename
        this._windowTabOrder = new Map(); // groupKey -> Meta.Window[], user-set via drag-reorder, see _commitWindowTabDragOrder
        this._pendingWindowTabOrder = new Map(); // groupKey -> stable_sequence[], persisted order not yet matched back to real windows this session, see _orderWindowTabGroup
        this._windowTabDragGroupKey = null; // groupKey currently mid-drag, see _startWindowTabDrag - _syncWindowTabStrips leaves this one group's button order alone while set, rather than fighting the live drag back to its last-committed order
        this._windowTabRestackRecheckId = null; // GLib timeout id, see _onWindowsRestacked
        this._untrackedSweepId = null; // GLib timeout id, see _startUntrackedWindowSweep

        this._minimizedSwitcher = null; // {actor, rows: [{actor, win}], selectedIndex, capturedId}, see _openMinimizedSwitcher

        this._applyTrayIcon(metadata.path);
        // Re-reads the panel background and swaps light/dark icon files if
        // the user switches Cinnamon theme without reloading the applet.
        this._themeSetId = Main.themeManager.connect("theme-set", () => {
            this._updateTrayIconForTheme();
            this._updateWindowTabBackgrounds();
        });
        this.set_applet_tooltip("Kortile");

        this._settings = new Settings.AppletSettings(this, this.uuid, instance_id);
        this._settings.bind("enabled", "tilingEnabled", this._onTilingEnabledSettingChanged.bind(this));
        this._settings.bind("default-layout", "defaultLayout", null);
        this._settings.bind(
            "remember-layout-per-workspace",
            "rememberLayoutPerWorkspace",
            this._onRememberLayoutSettingChanged.bind(this)
        );
        // Raw JSON string, {"wsIndex:monIndex": "layout", ...} -
        // deliberately not exposed in any Settings page (see
        // settings-schema.json's own "remembered-layouts" - not listed
        // under any section's "keys") since it's not meant to be hand-
        // edited, just this feature's own persisted state living somewhere
        // that survives a restart. _rememberedLayouts (a Map, parsed from
        // this) is what the rest of the code actually reads/writes -
        // kept in sync with this raw string via _saveRememberedLayouts()
        // (write) and the bind callback below (read, in case it's ever
        // changed some other way, e.g. by hand in the settings file).
        this._rememberedLayouts = new Map();
        this._settings.bind(
            "remembered-layouts",
            "rememberedLayoutsRaw",
            this._onRememberedLayoutsSettingChanged.bind(this)
        );
        this._parseRememberedLayouts();
        this._settings.bind("remember-floating-window-size-enabled", "rememberFloatingWindowSizeEnabled", null);
        // Same hidden-generic-JSON convention as remembered-layouts above,
        // just keyed by wm_class -> {w,h} instead of manager key -> layout.
        this._settings.bind(
            "remembered-floating-window-sizes",
            "rememberedFloatingWindowSizesRaw",
            this._onRememberedFloatingWindowSizesSettingChanged.bind(this)
        );
        this._parseFloatingWindowSizes();
        // Meta.Window itself has no identity that survives an applet
        // restart (a fresh reload's own _trackExisting() gets brand new JS
        // wrapper objects for whatever windows are still actually open) -
        // get_stable_sequence() is Mutter's own per-window integer that
        // does survive it (same primitive Cinnamon's own workspace/expo
        // thumbnails use to sort by real stacking across a similar
        // rebuild), so the persisted form here is groupKey -> stable
        // sequence numbers, resolved back to real Meta.Window references
        // in _orderWindowTabGroup once this session's own windows are
        // known. _windowTabOrder itself (Meta.Window[]) is what the rest
        // of the code actually reads during normal operation - unchanged
        // by any of this, it's just seeded from here once, the first time
        // each group is ever rebuilt this session.
        this._settings.bind(
            "remembered-window-tab-order",
            "rememberedWindowTabOrderRaw",
            this._onRememberedWindowTabOrderSettingChanged.bind(this)
        );
        this._parseWindowTabOrder();
        this._wmPrefs = new Gio.Settings({ schema_id: "org.cinnamon.desktop.wm.preferences" });
        this._muffinPrefs = new Gio.Settings({ schema_id: "org.cinnamon.muffin" });
        this._settings.bind(
            "alt-drag-move-resize-enabled",
            "altDragMoveResizeEnabled",
            this._onAltDragMoveResizeSettingChanged.bind(this)
        );
        this._applyAltDragMoveResizeSetting();
        this._settings.bind(
            "focus-follows-mouse-enabled",
            "focusFollowsMouseEnabled",
            this._onFocusFollowsMouseSettingChanged.bind(this)
        );
        this._settings.bind(
            "focus-follows-mouse-raise-enabled",
            "focusFollowsMouseRaiseEnabled",
            this._onFocusFollowsMouseSettingChanged.bind(this)
        );
        this._settings.bind(
            "focus-follows-mouse-raise-delay",
            "focusFollowsMouseRaiseDelay",
            this._onFocusFollowsMouseSettingChanged.bind(this)
        );
        this._applyFocusFollowsMouseSetting();
        this._settings.bind("focus-border-enabled", "focusBorderEnabled", this._onFocusBorderSettingChanged.bind(this));
        this._settings.bind("focus-border-color", "focusBorderColor", this._onFocusBorderStyleSettingChanged.bind(this));
        this._settings.bind("focus-border-width", "focusBorderWidth", this._onFocusBorderStyleSettingChanged.bind(this));
        this._settings.bind(
            "focus-border-hide-maximized",
            "focusBorderHideMaximized",
            this._onFocusBorderSettingChanged.bind(this)
        );
        this._applyFocusBorderStyle();
        this._settings.bind("window-tabs-enabled", "windowTabsEnabled", this._onWindowTabsSettingChanged.bind(this));
        this._settings.bind("window-tabs-grouping", "windowTabsGrouping", this._onWindowTabsSettingChanged.bind(this));
        this._settings.bind("window-tabs-min-windows", "windowTabsMinWindows", this._onWindowTabsSettingChanged.bind(this));
        this._settings.bind("window-tabs-style", "windowTabsStyle", this._onWindowTabsSettingChanged.bind(this));
        this._settings.bind("window-tabs-position", "windowTabsPosition", this._onWindowTabsSettingChanged.bind(this));
        this._settings.bind("window-tabs-side", "windowTabsSide", this._onWindowTabsSettingChanged.bind(this));
        this._settings.bind("window-tabs-stretch", "windowTabsStretch", this._onWindowTabsSettingChanged.bind(this));
        this._settings.bind("window-tabs-opaque", "windowTabsOpaque", this._onWindowTabsSettingChanged.bind(this));
        this._settings.bind(
            "window-tabs-custom-colors-enabled",
            "windowTabsCustomColorsEnabled",
            this._onWindowTabsSettingChanged.bind(this)
        );
        this._settings.bind(
            "window-tabs-background-color",
            "windowTabsBackgroundColor",
            this._onWindowTabsSettingChanged.bind(this)
        );
        this._settings.bind(
            "window-tabs-foreground-color",
            "windowTabsForegroundColor",
            this._onWindowTabsSettingChanged.bind(this)
        );
        this._settings.bind("window-tabs-text-color", "windowTabsTextColor", this._onWindowTabsSettingChanged.bind(this));
        this._settings.bind("gap-size", "gapSize", this._onGeometrySettingChanged.bind(this));
        this._settings.bind("masters-max", "mastersLimit", this._onLimitsSettingChanged.bind(this));
        this._settings.bind("slaves-max", "slavesLimit", this._onLimitsSettingChanged.bind(this));
        this._settings.bind("proportion-step", "proportionStep", null);
        this._settings.bind("proportion-min", "proportionMin", null);
        this._settings.bind("ignore-list", "ignoreListRaw", this._onIgnoreListChanged.bind(this));
        this._settings.bind("workspace-rules", "workspaceRulesRaw", this._onWorkspaceRulesChanged.bind(this));
        for (const kb of KEYBINDINGS) {
            this._settings.bind(kb.key, kb.prop, this._onKeybindingSettingChanged.bind(this));
        }
        this._parseIgnoreList();
        this._parseWorkspaceRules();

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this._buildMenu();

        this._connectGlobalSignals();
        this._bindKeybindings();
        if (this.tilingEnabled) {
            this._trackExisting();
            this._tileAll();
            this._updateFocusBorder();
            this._startUntrackedWindowSweep();
        }
        this._syncMenu();
    }

    on_applet_clicked(event) {
        // _syncMenu() only runs reactively (after an action, a settings
        // change, ...) - if the active layout ever changed some way that
        // didn't happen to trigger one (confirmed live: right after the
        // applet's own startup, before anything else touched the menu),
        // the toggles shown would be whatever they were last computed as,
        // not necessarily reality. Opening the menu is the one moment that
        // actually matters for this, so just always refresh right before.
        this._syncMenu();
        this.menu.toggle();
    }

    // icon_light.svg/icon_dark.svg carry their own deliberate fixed colors
    // (not just a single currentColor silhouette like the older icon.svg),
    // so they're loaded as plain full-color images (set_applet_icon_path)
    // rather than through the symbolic loader, which would otherwise flatten
    // them to one tint and defeat the point of having two of them. Picking
    // between them needs an actual light/dark read instead - the theme
    // *name* isn't reliable for that (confirmed live: this session's own
    // theme, "Nordic-bluish-accent", is a dark theme with no "dark" in a
    // place a name-substring check would catch), so _panelBackgroundIsDark
    // reads the real rendered panel background color instead. Only one of
    // the two existing is enough to use it for both cases - either is
    // better than falling back to the old single-color icon. Neither
    // existing falls back to icon.svg (symbolic) and then a stock icon, same
    // as before.
    _applyTrayIcon(metadataPath) {
        this._iconMetadataPath = metadataPath;
        const lightPath = `${metadataPath}/icon_light.svg`;
        const darkPath = `${metadataPath}/icon_dark.svg`;
        const hasLight = Gio.File.new_for_path(lightPath).query_exists(null);
        const hasDark = Gio.File.new_for_path(darkPath).query_exists(null);
        if (hasLight || hasDark) {
            this._iconLightPath = hasLight ? lightPath : darkPath;
            this._iconDarkPath = hasDark ? darkPath : lightPath;
            this._updateTrayIconForTheme();
            return;
        }

        const legacy = Gio.File.new_for_path(`${metadataPath}/icon.svg`);
        if (legacy.query_exists(null)) {
            this.set_applet_icon_symbolic_path(legacy.get_path());
        } else {
            this.set_applet_icon_symbolic_name("view-grid-symbolic");
        }
    }

    _updateTrayIconForTheme() {
        if (!this._iconLightPath || !this._iconDarkPath) return;
        this.set_applet_icon_path(this._panelBackgroundIsDark() ? this._iconDarkPath : this._iconLightPath);
    }

    // Reads the panel's own actual rendered background color rather than
    // guessing from the theme's name - defaults to treating it as dark
    // (matches this session's own Nordic-bluish-accent panel, and a light
    // icon on a light panel would be the more broken-looking failure mode
    // of the two) if the panel actor isn't available for whatever reason.
    _panelBackgroundIsDark() {
        const actor = this.panel && this.panel.actor;
        if (!actor) return true;
        const bg = actor.get_theme_node().get_background_color();
        const luminance = 0.2126 * bg.red + 0.7152 * bg.green + 0.0722 * bg.blue;
        return luminance < 130;
    }

    on_applet_removed_from_panel() {
        this._stopWindowPicker();
        this._closeMinimizedSwitcher();
        this._unbindKeybindings();
        this._disconnectGlobalSignals();
        if (this._themeSetId) Main.themeManager.disconnect(this._themeSetId);
        // Not a restore: this also runs on every reload (ReloadXlet, a
        // Cinnamon session restart, editing the applet), which should be
        // seamless. _originalGeometry is captured once, the first time a
        // window is ever tracked - if it's since been dragged to a
        // different monitor (which now works, see _commitGeometryChange),
        // restoring on every reload would snap it back to that stale spawn
        // position instead. Restoring is still correct for a deliberate
        // "disable tiling" - that's handled separately in _toggle().
        this._untrackAll(false);
        this._focusBorder.destroy();
        this._settings.finalize();
    }

    // ---- menu ----

    _buildMenu() {
        this._menuToggle = new PopupMenu.PopupSwitchMenuItem("Tiling enabled", !!this.tilingEnabled);
        this._menuToggle.connect("toggled", () => this._onAction("toggle"));
        this.menu.addMenuItem(this._menuToggle);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._menuLayoutItems = {};
        for (const layout of LAYOUTS) {
            const item = new PopupMenu.PopupSwitchMenuItem(LAYOUT_LABELS[layout], false);
            item.connect("toggled", () => this._onAction(`layout-${layout}`, { useFocusWindow: false }));
            this.menu.addMenuItem(item);
            this._menuLayoutItems[layout] = item;
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const addMasterItem = new PopupMenu.PopupMenuItem("Add master");
        addMasterItem.connect("activate", () => this._onAction("master-increase", { useFocusWindow: false }));
        this.menu.addMenuItem(addMasterItem);

        const removeMasterItem = new PopupMenu.PopupMenuItem("Remove master");
        removeMasterItem.connect("activate", () => this._onAction("master-decrease", { useFocusWindow: false }));
        this.menu.addMenuItem(removeMasterItem);

        const addSlaveItem = new PopupMenu.PopupMenuItem("Show one more slave");
        addSlaveItem.connect("activate", () => this._onAction("slave-increase", { useFocusWindow: false }));
        this.menu.addMenuItem(addSlaveItem);

        const removeSlaveItem = new PopupMenu.PopupMenuItem("Show one less slave");
        removeSlaveItem.connect("activate", () => this._onAction("slave-decrease", { useFocusWindow: false }));
        this.menu.addMenuItem(removeSlaveItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const restoreItem = new PopupMenu.PopupMenuItem("Restore original geometry");
        restoreItem.connect("activate", () => this._onAction("restore", { useFocusWindow: false }));
        this.menu.addMenuItem(restoreItem);

        const resetItem = new PopupMenu.PopupMenuItem("Reset layout");
        resetItem.connect("activate", () => this._onAction("reset", { useFocusWindow: false }));
        this.menu.addMenuItem(resetItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Same settings window the panel icon's own right-click "Configure..."
        // already opens (Cinnamon adds that one automatically for any
        // applet with a settings-schema.json, see Applet.Applet.
        // configureApplet in applet.js) - just reachable from this menu too,
        // for anyone who never right-clicks the icon to notice it's there.
        const settingsItem = new PopupMenu.PopupMenuItem("Settings...");
        settingsItem.connect("activate", () => this.configureApplet());
        this.menu.addMenuItem(settingsItem);

        const restartItem = new PopupMenu.PopupMenuItem("Restart Kortile");
        restartItem.connect("activate", () => this._restart());
        this.menu.addMenuItem(restartItem);
    }

    // Same call Cinnamon's own "Reload" (Looking Glass, or `cinnamon-settings
    // applets`) makes - tears this instance down (on_applet_removed_from_panel)
    // and starts a fresh one from the same on-disk applet.js, no session
    // restart needed. Useful on its own merits (not just for iterating on
    // this applet's own code): re-runs _trackExisting() from scratch, which
    // is the same recovery this README already points people at for a
    // window that's drifted out of tracking somehow (see _pendingTrack,
    // the workspace-renumbering handling above, ...) - a menu button here
    // means not having to know that "toggle tiling off and on" or the
    // Looking Glass even exist to reach the same fix.
    _restart() {
        ExtensionSystem.reloadExtension(this.uuid, ExtensionSystem.Type.APPLET);
    }

    _syncMenu() {
        if (this._menuToggle) this._menuToggle.setToggleState(!!this.tilingEnabled);

        const mg = this._activeManagerOrNull();
        const active = mg ? mg.layout : null;
        for (const [layout, item] of Object.entries(this._menuLayoutItems || {})) {
            item.setToggleState(layout === active);
        }
    }

    // ---- settings reactions ----

    _parseIgnoreList() {
        this._ignoreRegexes = [];
        const raw = this.ignoreListRaw || "";
        for (const line of raw.split("\n")) {
            const pattern = line.trim();
            if (!pattern) continue;
            try {
                this._ignoreRegexes.push(new RegExp(pattern));
            } catch (e) {
                global.logWarning(`[${this.uuid}] invalid ignore pattern "${pattern}": ${e.message}`);
            }
        }
    }

    // Picking a window via the picker (_addIgnoreClass) untiles that one
    // window immediately, but this fires for *any* change to the list -
    // typed directly into Settings' textview, or the picker adding a
    // pattern - and used to just re-parse the regexes and stop there,
    // leaving every already-tracked window matching the *new* pattern(s)
    // fully tiled regardless, until something unrelated happened to touch
    // it. Confirmed live: most apps report one wm_class for every one of
    // their windows, so picking one window to ignore writes a class-wide
    // pattern that immediately also matches every *other* already-open
    // window of that same app - only the one actually clicked got
    // untracked, the rest stayed fully tiled and indistinguishable from
    // never having matched at all, silently contradicting the ignore list
    // they're now supposed to be excluded by (and, sharing that manager,
    // very often sitting right next to the one that *did* get excluded).
    // Re-sweeps every currently tracked window against the updated
    // patterns and untiles (see _untrackWindow) whatever newly matches,
    // same as _addIgnoreClass already does for the one window picked
    // directly - checked via the ignore patterns specifically, not the
    // broader _isTileable (which would also catch minimized/floating/etc.
    // windows for reasons that have nothing to do with this list changing).
    _onIgnoreListChanged() {
        this._parseIgnoreList();
        const retiled = new Set();
        for (const mg of this._managers.values()) {
            for (const win of Array.from(mg.allWindows())) {
                if (!this._matchesIgnoreList(win)) continue;
                this._untrackWindow(win, mg);
                retiled.add(mg);
            }
        }
        for (const mg of retiled) this._retile(mg);
    }

    // ---- window picker (settings button callbacks) ----

    // Called by the "Pick a window to exclude..." settings button. Runs in
    // this applet's own process (unlike the settings dialog itself, which is
    // a separate GTK process with no access to Meta/window APIs) - grabs
    // input the same way Cinnamon's own Looking Glass inspector does, waits
    // for the next click, and adds that window's class to the ignore list.
    on_pick_window_pressed() {
        this._startWindowPicker("Kortile: click a window to exclude it (Esc to cancel)", (win) => this._addIgnoreClass(win));
    }

    // Called by the "Pick a window to add a rule..." settings button - same
    // input grab, but records the picked window's class together with its
    // *current* workspace as a startup placement rule. Switch to the target
    // workspace (or move the window there) before picking.
    on_pick_workspace_rule_pressed() {
        this._startWindowPicker(
            "Kortile: click a window to assign its current workspace (Esc to cancel)",
            (win) => this._addWorkspaceRule(win)
        );
    }

    _startWindowPicker(labelText, onPick) {
        if (this._pickerHandler) return;
        this._pickerOnPick = onPick;

        const handler = new St.BoxLayout({ name: "KortileWindowPicker", reactive: true });
        Main.uiGroup.add_actor(handler);
        Main.pushModal(handler);
        this._pickerHandler = handler;
        this._pickerCapturedId = global.stage.connect("captured-event", (actor, event) => this._onPickerEvent(event));

        this._pickerLabel = new St.Label({
            text: labelText,
            style_class: "kortile-picker-label",
            style: "background-color: rgba(0,0,0,0.8); color: white; padding: 8px 14px; border-radius: 4px; font-weight: bold;",
        });
        Main.uiGroup.add_actor(this._pickerLabel);
        const monitor = Main.layoutManager.primaryMonitor;
        this._pickerLabel.set_position(
            monitor.x + Math.floor((monitor.width - this._pickerLabel.get_preferred_width(-1)[1]) / 2),
            monitor.y + 40
        );
    }

    _stopWindowPicker() {
        if (!this._pickerHandler) return;
        // popModal can throw ("incorrect pop") if the modal stack was
        // disturbed by something else in the meantime - still tear down our
        // own state either way so a stuck picker can't wedge the applet.
        try {
            global.stage.disconnect(this._pickerCapturedId);
            Main.popModal(this._pickerHandler);
        } catch (e) {
            global.logWarning(`[${this.uuid}] error closing window picker: ${e}`);
        }
        this._pickerHandler.destroy();
        this._pickerHandler = null;
        this._pickerCapturedId = null;
        this._pickerOnPick = null;
        if (this._pickerLabel) {
            this._pickerLabel.destroy();
            this._pickerLabel = null;
        }
    }

    _onPickerEvent(event) {
        const type = event.type();
        if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
            this._stopWindowPicker();
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_PRESS) {
            const [x, y] = event.get_coords();
            const win = this._anyWindowAtPoint({ x, y });
            const onPick = this._pickerOnPick;
            this._stopWindowPicker();
            if (win && onPick) onPick(win);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_STOP;
    }

    // Unlike _windowAtPoint (manager.js members only), this searches every
    // normal window on screen, tiled or not - the whole point of the picker
    // is to be able to exclude windows kortile is currently tiling too.
    _anyWindowAtPoint(point) {
        let found = null;
        for (const actor of global.get_window_actors()) {
            const win = actor.get_meta_window();
            if (win.get_window_type() !== Meta.WindowType.NORMAL) continue;
            const r = win.get_frame_rect();
            if (point.x >= r.x && point.x < r.x + r.width && point.y >= r.y && point.y < r.y + r.height) {
                found = win; // get_window_actors() is bottom-to-top, keep the topmost match
            }
        }
        return found;
    }

    _addIgnoreClass(win) {
        const cls = win.get_wm_class();
        if (!cls) return;
        const pattern = `^${cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;

        const lines = (this.ignoreListRaw || "")
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        if (!lines.includes(pattern)) {
            lines.push(pattern);
            this.ignoreListRaw = lines.join("\n");
            this._settings.setValue("ignore-list", this.ignoreListRaw);
        }

        // Always re-sweep, not just when the pattern is newly added -
        // covers both "picked a window whose class wasn't ignored yet"
        // (the common case) and "picked a window matching an
        // already-existing pattern that somehow stayed tracked anyway"
        // alike in one place, rather than this function separately
        // special-casing just the one window clicked - see
        // _onIgnoreListChanged just above for why untiling only that one
        // window isn't enough by itself (most apps share one wm_class
        // across every one of their windows, so this one pattern usually
        // also matches others already open).
        this._onIgnoreListChanged();
    }

    // Detaches a window from tiling entirely: removes it from its manager,
    // disconnects our signal handlers, cancels any pending timers/polls for
    // it, and clears its per-window bookkeeping. Used whenever a window
    // should stop being tiled while it (or the applet) is still alive -
    // added to the ignore list, or explicitly restored - so it can't
    // silently get swept back into the tile by the next unrelated retile
    // with stale bookkeeping (a stale _lastAppliedRect in particular could
    // misread the restored position as a swap or resize against whatever
    // it used to be). Doesn't retile the vacated manager itself - callers
    // that want the remaining windows to fill the gap do that themselves.
    _untrackWindow(win, mg) {
        mg.removeWindow(win);
        this._detachWindowSignals(win);
        this._clearClip(win);
        this._originalGeometry.delete(win);
        this._lastAppliedRect.delete(win);
        this._lastRequestedRect.delete(win);
        this._stubbornCount.delete(win);
        this._dragFlag.delete(win);
        this._clipGeneration.delete(win);
        this._floatingWindows.delete(win);
        this._nativeMaximizedWindows.delete(win);
        this._removedWindowPosition.delete(win);
        this._windowTabCustomNames.delete(win);
        this._minimizedWindowManager.delete(win);
        this._cancelGeometryDebounce(win);
        this._stopEnforcing(win);
        this._cancelDragReleasePoll(win);
        // Not hiding the focus border here even if win is currently
        // outlined: the border also covers focused non-tiled windows (see
        // _updateFocusBorder), so a window that just stopped being tiled
        // (ignore-listed, restored) should simply keep being treated as
        // one of those, not lose the outline.
    }

    _onGeometrySettingChanged() {
        this._tileAll();
    }

    // masters-max/slaves-max are copied into each Manager at construction
    // time (mastersLimit/slavesLimit) rather than read live, so changing
    // the setting after a manager already exists silently had no effect on
    // it - only brand-new managers (a workspace/monitor combo not used
    // yet) picked up the new value. Push the new limits into every
    // existing manager here instead, clamping its current max down to fit
    // if needed.
    _onLimitsSettingChanged() {
        for (const mg of this._managers.values()) {
            mg.mastersLimit = this.mastersLimit;
            mg.slavesLimit = this.slavesLimit;
            if (mg.mastersMax > mg.mastersLimit) mg.mastersMax = mg.mastersLimit;
            if (mg.slavesMax > mg.slavesLimit) mg.slavesMax = mg.slavesLimit;
        }
        this._tileAll();
    }

    // ---- startup workspace rules ----

    _parseWorkspaceRules() {
        this._workspaceRules = [];
        const raw = this.workspaceRulesRaw || "";
        for (const line of raw.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const m = trimmed.match(/^(\d+)\s+(.+)$/);
            if (!m) {
                global.logWarning(`[${this.uuid}] invalid workspace rule "${trimmed}" (expected "<workspace number> <pattern>")`);
                continue;
            }
            try {
                this._workspaceRules.push({ workspaceIndex: parseInt(m[1], 10), regex: new RegExp(m[2]) });
            } catch (e) {
                global.logWarning(`[${this.uuid}] invalid workspace rule pattern "${m[2]}": ${e.message}`);
            }
        }
    }

    _onWorkspaceRulesChanged() {
        this._parseWorkspaceRules();
    }

    // Moves a freshly-created window to its configured workspace, if any
    // rule matches - called before tracking, so it ends up tiled on the
    // right workspace's manager immediately rather than getting moved there
    // after the fact.
    _applyWorkspaceRule(win) {
        const wmClass = win.get_wm_class() || "";
        const title = win.get_title() || "";
        for (const rule of this._workspaceRules) {
            if (!rule.regex.test(wmClass) && !rule.regex.test(title)) continue;
            if (rule.workspaceIndex >= global.workspace_manager.get_n_workspaces()) return;
            const ws = win.get_workspace();
            if (!ws || ws.index() !== rule.workspaceIndex) {
                win.change_workspace_by_index(rule.workspaceIndex, false);
            }
            return; // first match wins
        }
    }

    _addWorkspaceRule(win) {
        const cls = win.get_wm_class();
        if (!cls) return;
        const ws = win.get_workspace();
        const wsIndex = ws ? ws.index() : 0;
        const pattern = `^${cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;

        const lines = (this.workspaceRulesRaw || "")
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
            .filter((l) => {
                const m = l.match(/^(\d+)\s+(.+)$/);
                return !(m && m[2] === pattern); // drop any existing rule for this class, replaced below
            });
        lines.push(`${wsIndex} ${pattern}`);
        this.workspaceRulesRaw = lines.join("\n");
        this._settings.setValue("workspace-rules", this.workspaceRulesRaw);
        this._parseWorkspaceRules();
    }

    // ---- keybindings ----

    _bindKeybindings() {
        this._kbNames = [];
        for (const kb of KEYBINDINGS) {
            const binding = this[kb.prop];
            if (!binding) continue;
            const name = `${this.uuid}-${kb.action}`;
            Main.keybindingManager.addHotKey(name, binding, () => this._onAction(kb.action));
            this._kbNames.push(name);
        }
    }

    _unbindKeybindings() {
        for (const name of this._kbNames) {
            Main.keybindingManager.removeHotKey(name);
        }
        this._kbNames = [];
    }

    // The accelerator string only actually reaches Main.keybindingManager at
    // bind time (addHotKey) - the settings prop (this[kb.prop]) itself
    // updates immediately on any change, but confirmed live that the *grab*
    // silently keeps using whatever it was bound with until unbound and
    // rebound, so a keybinding changed via Settings (or programmatically)
    // would otherwise appear to take effect (the value looks right) while
    // actually doing nothing until the next full applet reload.
    _onKeybindingSettingChanged() {
        this._unbindKeybindings();
        this._bindKeybindings();
    }

    // ---- window tracking ----

    _managerKey(wsIndex, monIndex) {
        return `${wsIndex}:${monIndex}`;
    }

    // Cinnamon's "Workspaces only on primary display" (on by default) means
    // every monitor but the primary always shows the same windows no matter
    // which workspace is active - Mutter reflects that by reporting such a
    // window as is_on_all_workspaces()=true and by making get_workspace()
    // mirror whatever the *primary* monitor's active index is, neither of
    // which is a real per-window property there. A fixed sentinel groups
    // all of a secondary monitor's windows into one manager instead of
    // fragmenting them across a new one every time the primary switches
    // workspace (which get_workspace() would otherwise make it look like).
    _isWorkspaceIndependentMonitor(monIndex) {
        return monIndex !== Main.layoutManager.primaryIndex && this._muffinPrefs.get_boolean("workspaces-only-on-primary");
    }

    _wsIndexForMonitor(monIndex, rawWsIndex) {
        return this._isWorkspaceIndependentMonitor(monIndex) ? -1 : rawWsIndex;
    }

    _getOrCreateManager(wsIndex, monIndex) {
        const key = this._managerKey(wsIndex, monIndex);
        let mg = this._managers.get(key);
        if (!mg) {
            // "Remember each workspace/monitor's own layout across
            // restarts" (off by default, see settings-schema.json) - a
            // fresh manager otherwise always starts from defaultLayout
            // regardless of whatever this same (workspace, monitor) was
            // last actually switched to, which on a genuine restart (every
            // manager rebuilt from scratch) looked exactly like every
            // workspace's own layout choice being silently discarded.
            const remembered = this.rememberLayoutPerWorkspace && this._rememberedLayouts.get(key);
            const layout = remembered && LAYOUTS.includes(remembered) ? remembered : this.defaultLayout;
            mg = new Manager(wsIndex, monIndex, layout, this.mastersLimit, this.slavesLimit);
            this._managers.set(key, mg);
        }
        return mg;
    }

    // rememberedLayoutsRaw's own bind callback - only meaningfully fires
    // for an *external* change (something other than this same applet's
    // own _saveRememberedLayouts() call, e.g. hand-editing the settings
    // file), same as every other raw-string setting here (ignore-list,
    // workspace-rules, ...) - re-parses from scratch rather than trying to
    // patch the existing Map in place.
    _onRememberedLayoutsSettingChanged() {
        this._parseRememberedLayouts();
    }

    _parseRememberedLayouts() {
        this._rememberedLayouts = new Map();
        if (!this.rememberedLayoutsRaw) return;
        let parsed;
        try {
            parsed = JSON.parse(this.rememberedLayoutsRaw);
        } catch (e) {
            // Corrupt/hand-edited into something invalid - starting over
            // from an empty map (rather than throwing, or leaving
            // whatever the previous, possibly stale, Map already had) is
            // the same "least surprising" recovery _parseIgnoreList()
            // etc. already default to elsewhere for bad settings input.
            return;
        }
        if (!parsed || typeof parsed !== "object") return;
        for (const [key, layout] of Object.entries(parsed)) {
            if (LAYOUTS.includes(layout)) this._rememberedLayouts.set(key, layout);
        }
    }

    _saveRememberedLayouts() {
        const obj = Object.fromEntries(this._rememberedLayouts);
        this._settings.setValue("remembered-layouts", JSON.stringify(obj));
    }

    // Same idea as _onRememberedLayoutsSettingChanged/_parseRememberedLayouts
    // just above, for remember-floating-window-size-enabled's own hidden
    // storage instead.
    _onRememberedFloatingWindowSizesSettingChanged() {
        this._parseFloatingWindowSizes();
    }

    _parseFloatingWindowSizes() {
        this._floatingWindowSizes = new Map();
        if (!this.rememberedFloatingWindowSizesRaw) return;
        let parsed;
        try {
            parsed = JSON.parse(this.rememberedFloatingWindowSizesRaw);
        } catch (e) {
            return;
        }
        if (!parsed || typeof parsed !== "object") return;
        for (const [wmClass, size] of Object.entries(parsed)) {
            if (!wmClass) continue;
            const w = Number(size && size.w);
            const h = Number(size && size.h);
            if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) {
                this._floatingWindowSizes.set(wmClass, { w, h });
            }
        }
    }

    _saveFloatingWindowSizes() {
        const obj = Object.fromEntries(this._floatingWindowSizes);
        this._settings.setValue("remembered-floating-window-sizes", JSON.stringify(obj));
    }

    // Same idea as _onRememberedLayoutsSettingChanged/_parseRememberedLayouts
    // further up, for remembered-window-tab-order's own hidden storage
    // instead - see the constructor's own comment on why this is stable
    // sequence numbers rather than the Meta.Window[] _windowTabOrder itself
    // holds during normal operation.
    _onRememberedWindowTabOrderSettingChanged() {
        this._parseWindowTabOrder();
    }

    _parseWindowTabOrder() {
        this._pendingWindowTabOrder = new Map();
        if (!this.rememberedWindowTabOrderRaw) return;
        let parsed;
        try {
            parsed = JSON.parse(this.rememberedWindowTabOrderRaw);
        } catch (e) {
            return;
        }
        if (!parsed || typeof parsed !== "object") return;
        for (const [key, seqs] of Object.entries(parsed)) {
            if (Array.isArray(seqs)) this._pendingWindowTabOrder.set(key, seqs);
        }
    }

    _saveWindowTabOrder() {
        const obj = {};
        for (const [key, windows] of this._windowTabOrder) {
            obj[key] = windows.map((w) => w.get_stable_sequence());
        }
        this._settings.setValue("remembered-window-tab-order", JSON.stringify(obj));
    }

    // "Floating" here means anything kortile isn't currently tiling - an
    // explicitly floated window (kb-toggle-floating) or an ignore-listed
    // one alike, the same two cases _reserveWindowTabSpace's own "foreign
    // window" concept used to cover before that whole check was replaced by
    // real stacking (see _restackWindowTabStrip). Deliberately not reusing
    // _isTileable itself - that also excludes ignore-listed windows, which
    // is exactly the case this feature most wants to cover (a window kortile
    // will never tile is exactly one whose own size, if it doesn't remember
    // it itself, has nothing else to fall back on).
    _shouldRememberFloatingSize(win) {
        if (!this.rememberFloatingWindowSizeEnabled) return false;
        if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
        if (win.is_skip_taskbar()) return false;
        if (win.get_transient_for()) return false;
        if (win.minimized) return false;
        if (this._managerFor(win)) return false;
        return true;
    }

    // Applied once, right after a brand-new window's tracking outcome is
    // decided (see _onWindowCreated) - keeps whatever position the window
    // (or its own app) chose for itself, only overriding size, since this
    // feature is explicitly about size, not placement.
    _applyRememberedFloatingSize(win) {
        const wmClass = win.get_wm_class() || "";
        if (!wmClass) return;
        const size = this._floatingWindowSizes.get(wmClass);
        if (!size) return;
        const r = win.get_frame_rect();
        if (r.width === size.w && r.height === size.h) return;
        win.move_resize_frame(false, r.x, r.y, size.w, size.h);
    }

    // Connected once per window at creation (see _onWindowCreated),
    // regardless of whether it ends up tiled - _shouldRememberFloatingSize
    // itself is what keeps this a no-op while tiled, so a window later
    // toggled floating (kb-toggle-floating) starts being remembered from
    // its very next resize with no extra wiring needed here. Debounced by
    // wm_class (same 500ms idea _onWindowGeometryChanged's own debounce
    // uses, just simpler - this doesn't need to distinguish a real drag
    // from an app's own resize the way tiling's stubborn-app handling
    // does) so a live resize drag doesn't write to disk on every
    // intermediate frame.
    _onFloatingWindowSizeChanged(win) {
        if (!this._shouldRememberFloatingSize(win)) return;
        const wmClass = win.get_wm_class() || "";
        if (!wmClass) return;
        if (this._floatingSizeDebounce.has(wmClass)) {
            GLib.source_remove(this._floatingSizeDebounce.get(wmClass));
        }
        this._floatingSizeDebounce.set(
            wmClass,
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                this._floatingSizeDebounce.delete(wmClass);
                // The window can close mid-debounce - get_compositor_private()
                // is gone the instant that happens, same "still alive?" check
                // _onWindowCreated's own deferred track() uses.
                if (!win.get_compositor_private()) return GLib.SOURCE_REMOVE;
                const r = win.get_frame_rect();
                this._floatingWindowSizes.set(wmClass, { w: r.width, h: r.height });
                this._saveFloatingWindowSizes();
                return GLib.SOURCE_REMOVE;
            })
        );
    }

    // Called from _cycleLayout/_setLayout (the only two places mg.layout
    // itself ever actually changes) - a no-op unless the feature is on, so
    // this is safe to call unconditionally from both rather than
    // duplicating the enabled-check at every call site.
    _rememberLayoutFor(mg) {
        if (!this.rememberLayoutPerWorkspace) return;
        this._rememberedLayouts.set(this._managerKey(mg.workspaceIndex, mg.monitorIndex), mg.layout);
        this._saveRememberedLayouts();
    }

    // Toggling the feature on captures whatever every currently-live
    // manager is already showing right away, rather than only ever
    // remembering a layout from the *next* change someone happens to make
    // after turning this on - otherwise turning it on and restarting
    // immediately afterward would still "forget" everything exactly once
    // more, the same complaint that led to this feature existing at all.
    _onRememberLayoutSettingChanged() {
        if (!this.rememberLayoutPerWorkspace) return;
        for (const mg of this._managers.values()) {
            this._rememberedLayouts.set(this._managerKey(mg.workspaceIndex, mg.monitorIndex), mg.layout);
        }
        this._saveRememberedLayouts();
    }

    _managerFor(win) {
        for (const mg of this._managers.values()) {
            if (mg.hasWindow(win)) return mg;
        }
        return null;
    }

    _activeManager() {
        const monIndex = Main.layoutManager.currentMonitor.index;
        const wsIndex = this._wsIndexForMonitor(monIndex, global.workspace_manager.get_active_workspace_index());
        return this._getOrCreateManager(wsIndex, monIndex);
    }

    _activeManagerOrNull() {
        const monIndex = Main.layoutManager.currentMonitor.index;
        const wsIndex = this._wsIndexForMonitor(monIndex, global.workspace_manager.get_active_workspace_index());
        return this._managers.get(this._managerKey(wsIndex, monIndex)) || null;
    }

    _isTileable(win) {
        if (!win) return false;
        // Explicitly floated via kb-toggle-floating - stays untiled through
        // anything that would otherwise re-track it (e.g. minimize/restore)
        // until toggled back, see _toggleFloating.
        if (this._floatingWindows.has(win)) return false;
        // Native-maximized/fullscreened while already tiled - stays untiled
        // until it un-maximizes/un-fullscreens, same idea as the floating
        // check just above (see _onWindowMaximizedChanged/
        // _onWindowFullscreenChanged and _nativeMaximizedWindows itself).
        // Deliberately not just "win.get_maximized() !== 0" here: that would
        // also reject a *brand-new* window that simply opens already
        // maximized, which still needs to pass this check the first time so
        // _trackWindow forces it into the tile (see _commitGeometryChange's
        // own unmaximize() call) - this set is only ever populated for a
        // window _onWindowMaximizedChanged found *already* tracked, never
        // for one that isn't tracked yet.
        if (this._nativeMaximizedWindows.has(win)) return false;
        if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
        if (win.is_skip_taskbar()) return false;
        if (win.get_transient_for()) return false;
        if (win.minimized) return false;
        if (win.is_fullscreen()) return false;
        if (win.is_always_on_all_workspaces && win.is_always_on_all_workspaces()) return false;
        // A window explicitly pinned to all workspaces (not just a
        // window *type* that's inherently always-on-all, like a desktop
        // icon) still passed this before - get_workspace() on it tracks
        // whatever workspace happens to be active rather than a fixed one,
        // so it kept ending up misfiled under whatever manager was active
        // at the moment it was first tracked, and its apparent workspace
        // would keep "changing" on its own as the user switched desktops.
        // Every window on a secondary monitor reports this exact same
        // is_on_all_workspaces()=true under Cinnamon's (default) "Workspaces
        // only on primary display" - not a per-window pin there, just what
        // that setting means, so it's not a reason to exclude them (see
        // _isWorkspaceIndependentMonitor).
        if (
            win.is_on_all_workspaces &&
            win.is_on_all_workspaces() &&
            !this._isWorkspaceIndependentMonitor(win.get_monitor())
        ) {
            return false;
        }

        if (this._matchesIgnoreList(win)) return false;
        return true;
    }

    _matchesIgnoreList(win) {
        const wmClass = win.get_wm_class() || "";
        const title = win.get_title() || "";
        return this._ignoreRegexes.some((re) => re.test(wmClass) || re.test(title));
    }

    // retile=false lets callers batch many additions (e.g. initial load) into
    // a single _tileAll() instead of one animated move_resize_frame per window
    // added - firing retile once per window in a tight loop causes many
    // overlapping resize animations on the same windows that never converge
    // cleanly to the final layout.
    // raiseIt: explicitly raises the window above whatever else shares its
    // slot - only meaningful (and only ever passed true) when this window is
    // genuinely becoming visible/active right now (a brand new window, one
    // un-minimizing, un-fullscreening, or un-floating), never for
    // _trackExisting()'s startup batch-load, which would otherwise re-stack
    // every already-open window in loop order and scramble however the user
    // actually had them arranged. In maximized layout especially, every
    // window in a manager shares the *exact* same screen rect, so whichever
    // one is on top is the only thing that actually matters for whether the
    // user can see it at all - this applet never called raise() anywhere
    // before, relying entirely on Mutter's own "a new/reactivated window
    // raises and focuses itself" behavior, which is not reliable in this
    // environment (confirmed live elsewhere this session: a window reported
    // as focused was repeatedly not the one actually on top). Confirmed live
    // this can otherwise make a newly-opened window (or a re-shown one)
    // visually indistinguishable from nothing having happened at all, if it
    // ends up stacked behind other windows sharing its slot.
    _trackWindow(win, retile = true, raiseIt = false) {
        if (!this._isTileable(win)) return;
        if (this._managerFor(win)) return;

        const ws = win.get_workspace();
        const monIndex = win.get_monitor();
        const wsIndex = this._wsIndexForMonitor(monIndex, ws ? ws.index() : global.workspace_manager.get_active_workspace_index());
        const mg = this._getOrCreateManager(wsIndex, monIndex);

        if (!this._originalGeometry.has(win)) {
            this._originalGeometry.set(win, rectFromMeta(win.get_frame_rect()));
            this._attachWindowSignals(win);
        }

        // A window coming back from a *temporary* removal (minimized,
        // native-maximized/fullscreened, explicitly floated) restores near
        // its old slot instead of jumping to the front the way addWindow()'s
        // own front-insert would (see manager.js restoreWindow) - only when
        // it's rejoining the *same* manager it left; a workspace/monitor
        // change while it was away means that remembered slot doesn't mean
        // anything here anymore, so that still falls through to a plain
        // front-insert.
        const restore = this._removedWindowPosition.get(win);
        this._removedWindowPosition.delete(win);
        if (restore && restore.mg === mg) {
            mg.restoreWindow(win, restore.info);
        } else {
            mg.addWindow(win);
        }
        // After retiling, not before - confirmed live raising here first and
        // then retiling let a sibling end up back on top anyway (move_resize_frame()
        // on the rest of the manager's windows seems to disturb stacking order
        // again), while raising *after* everything has already settled reliably
        // sticks.
        if (retile) this._retile(mg);
        if (raiseIt) win.raise();
    }

    _trackExisting() {
        for (const actor of global.get_window_actors()) {
            this._trackWindow(actor.get_meta_window(), false);
        }
        this._tileAll();
    }

    _untrackAll(restore) {
        this._cancelWorkspaceSwitchRetile();
        if (this._windowTabRestackRecheckId) {
            GLib.source_remove(this._windowTabRestackRecheckId);
            this._windowTabRestackRecheckId = null;
        }
        for (const mg of this._managers.values()) {
            if (restore) this._restoreManager(mg);
        }
        for (const win of Array.from(this._windowSignals.keys())) {
            this._detachWindowSignals(win);
        }
        for (const win of Array.from(this._geometryDebounce.keys())) {
            this._cancelGeometryDebounce(win);
        }
        for (const win of Array.from(this._enforceTimers.keys())) {
            this._stopEnforcing(win);
        }
        for (const win of Array.from(this._releasePoll.keys())) {
            this._cancelDragReleasePoll(win);
        }
        this._managers.clear();
        this._originalGeometry.clear();
        this._lastAppliedRect.clear();
        this._lastRequestedRect.clear();
        this._stubbornCount.clear();
        this._dragFlag.clear();
        this._clipGeneration.clear();
        this._floatingWindows.clear();
        this._nativeMaximizedWindows.clear();
        this._removedWindowPosition.clear();
        this._minimizedWindowManager.clear();
        this._pendingTrack.clear();
        this._hideFocusBorder();
        this._destroyAllWindowTabStrips();
    }

    _attachWindowSignals(win) {
        const ids = [
            win.connect("unmanaged", () => this._onWindowUnmanaged(win)),
            win.connect("workspace-changed", () => this._onWindowWorkspaceChanged(win)),
            win.connect("notify::minimized", () => this._onWindowMinimizedChanged(win)),
            // A tiled window going fullscreen (video player, F11 in a
            // browser, ...) used to get fought: _commitGeometryChange saw
            // its now-fullscreen geometry as an unrequested external change
            // and immediately tried to shrink it straight back into its
            // tile slot, then kept re-asserting that every couple of
            // seconds for as long as fullscreen stayed active. Stop tiling
            // it for the duration instead, same idea as minimizing.
            win.connect("notify::fullscreen", () => this._onWindowFullscreenChanged(win)),
            // Apps that restore their own last-known window state (session
            // restore, "remember maximized" etc.) can (re-)maximize themselves
            // asynchronously shortly after being mapped and tiled, overriding
            // our placement - undo that to keep the tile intact.
            win.connect("notify::maximized-horizontally", () => this._onWindowMaximizedChanged(win)),
            win.connect("notify::maximized-vertically", () => this._onWindowMaximizedChanged(win)),
            // Manually resizing (or moving) a tiled window should snap it back
            // to its tile. _retile() records what it last applied per window
            // so this can tell "our own change settling" apart from a
            // genuine external resize/move.
            win.connect("size-changed", () => this._onWindowGeometryChanged(win)),
            win.connect("position-changed", () => this._onWindowGeometryChanged(win)),
            // A window's title is very often still whatever generic/blank
            // placeholder it launched with at the exact moment it's first
            // tracked (see _windowTabTitle/_windowTabDisplayTitle) - most
            // apps set their real one asynchronously a moment later. Without
            // this, a tab's label/tooltip only ever picked that up as a side
            // effect of some *other* retile trigger happening to run first
            // (switching to a neighboring tab, say) - confirmed live as
            // exactly the bug just reported: a brand new window's tab sat
            // there showing its stale launch title until something else
            // incidentally refreshed it.
            win.connect("notify::title", () => this._onWindowTitleChanged(win)),
        ];
        this._windowSignals.set(win, ids);
    }

    _detachWindowSignals(win) {
        const ids = this._windowSignals.get(win) || [];
        for (const id of ids) {
            try {
                win.disconnect(id);
            } catch (e) {
                // window is already gone
            }
        }
        this._windowSignals.delete(win);
    }

    // ---- tiling ----

    // Returns {x,y,w,h} of the monitor's work area (panels/docks already
    // excluded by Cinnamon) for a manager's (workspace, monitor), or null if
    // either no longer exists (e.g. a monitor was just unplugged).
    _workAreaRect(mg) {
        const monitor = Main.layoutManager.monitors[mg.monitorIndex];
        if (!monitor) return null;
        // A workspace-independent monitor's manager uses the -1 sentinel
        // (see _isWorkspaceIndependentMonitor) since it isn't tied to any
        // real workspace - work area (panel/dock exclusion) is the same for
        // a given monitor no matter which workspace it's queried through,
        // so any real one (whichever's active) works to look it up.
        const wsIndex = mg.workspaceIndex >= 0 ? mg.workspaceIndex : global.workspace_manager.get_active_workspace_index();
        const ws = global.workspace_manager.get_workspace_by_index(wsIndex);
        if (!ws) return null;
        const wa = ws.get_work_area_for_monitor(mg.monitorIndex);
        return { x: wa.x, y: wa.y, w: wa.width, h: wa.height };
    }

    // Passed to every Manager.compute() call as its groupKeyFn - keeps
    // slave windows of the same app round-robining into the *same* visible
    // slot together rather than scattering by raw array position.
    // Confirmed live that without this, an app with more open windows than
    // there were visible slave slots got split across as many separate
    // (and separately tab-stripped, see _reserveWindowTabSpace) groups as
    // it had instances, rather than the one shared strip a user switching
    // between them would expect.
    _windowGroupKey(win) {
        return win.get_wm_class() || "";
    }

    _retile(mg) {
        if (!mg) return;
        const wa = this._workAreaRect(mg);
        if (!wa) return;
        const rects = mg.compute(wa, this.gapSize || 0, (w) => this._windowGroupKey(w));
        const tabGroups = this._reserveWindowTabSpace(mg, rects);

        // move_frame/move_resize_frame can fire size-changed/position-changed
        // synchronously, mid-call - without this guard, _onWindowGeometryChanged
        // reacting to that echo (comparing against a not-yet-updated
        // _lastAppliedRect) would call _retile() again from inside this very
        // call, recursing until Cinnamon aborts with "too much recursion".
        if (this._retiling) return;
        this._retiling = true;
        try {
            this._applyRects(rects);
        } finally {
            this._retiling = false;
        }
        this._syncWindowTabStrips(mg, tabGroups);
    }

    // Mirrors _panelBackgroundIsDark's approach (read the theme's own
    // actual rendered color rather than guessing) but for the window-tab
    // strip's background - reuses whatever color the current Cinnamon
    // theme paints the panel itself, so the strip visually belongs to the
    // desktop instead of being a fixed color that could clash with a light
    // theme. Falls back to WINDOW_TAB_BACKGROUND_FALLBACK_HEX (a Nord tone)
    // when no panel actor is available yet, or the theme's panel
    // background resolves fully transparent (alpha 0 - nothing to derive a
    // color from, and forwarding that straight through would make every
    // strip invisible rather than just untinted).
    //
    // windowTabsCustomColorsEnabled (off by default) skips all of that and
    // just uses whatever the user picked instead - deliberately a separate
    // opt-in rather than always preferring a custom color the moment one's
    // set, so the theme-matching behavior above stays the out-of-the-box
    // default for anyone who never touches this, and the eyedropper on the
    // colorchooser itself (Settings → Tiling) already covers "match my
    // theme exactly" for anyone who does want a fixed color close to it.
    //
    // windowTabsOpaque (off by default, independent of the above) drops the
    // 0.85 translucency every branch here otherwise uses - kept as its own
    // toggle rather than folded into "solid" always being what a custom
    // color implies, since the strip's default theme-matched background is
    // just as reasonably wanted fully solid.
    _windowTabBackgroundColor() {
        const alpha = this.windowTabsOpaque ? 1 : 0.85;
        if (this.windowTabsCustomColorsEnabled) return hexToRgba(this.windowTabsBackgroundColor, alpha);
        const actor = this.panel && this.panel.actor;
        if (!actor) return hexToRgba(WINDOW_TAB_BACKGROUND_FALLBACK_HEX, alpha);
        const bg = actor.get_theme_node().get_background_color();
        if (bg.alpha === 0) return hexToRgba(WINDOW_TAB_BACKGROUND_FALLBACK_HEX, alpha);
        return `rgba(${bg.red}, ${bg.green}, ${bg.blue}, ${alpha})`;
    }

    // Same custom-colors opt-in as the background above - "foreground" here
    // is just the hover/focus highlight tint, white otherwise (matching
    // what was hardcoded here before this setting existed). Title text
    // itself is a separate, always-on windowTabsTextColor pick (see
    // _windowTabForegroundHex) - it used to share this same opt-in/color
    // pair, but that meant picking a text color forced overriding the
    // background away from its own theme-matched default too, just to
    // reach the toggle that unlocked it.
    _windowTabForegroundRgba(alpha) {
        if (this.windowTabsCustomColorsEnabled) return hexToRgba(this.windowTabsForegroundColor, alpha);
        return `rgba(255, 255, 255, ${alpha})`;
    }

    // Independent of windowTabsCustomColorsEnabled on purpose - unlike the
    // background/highlight above, there's no theme-derived default to
    // preserve here worth gating behind an opt-in, so this is just a plain
    // always-available color pick, white by default (same as the old
    // hardcoded value this replaced).
    _windowTabForegroundHex() {
        return this.windowTabsTextColor;
    }

    _windowTabStripStyle() {
        return `spacing: 2px; padding: 2px; background-color: ${this._windowTabBackgroundColor()}; border-radius: 4px;`;
    }

    // Called from the theme-set handler (see the constructor) - an
    // already-built strip's actor.style was set once at creation time
    // (_syncWindowTabStrips) and nothing else ever revisits it, so a
    // theme switch without this would leave every existing strip showing
    // the *previous* theme's color until it happened to be torn down and
    // rebuilt for some unrelated reason.
    _updateWindowTabBackgrounds() {
        const style = this._windowTabStripStyle();
        for (const entry of this._windowTabGroups.values()) entry.actor.style = style;
    }

    // Groups compute()'s output by identical rect (a shared slot - several
    // windows round-robining into the same visible slot all get the exact
    // same rect, see Manager.compute()), then looks at which one of them
    // is actually visible right now - whichever is topmost in real window
    // stacking order, same primitive _windowAtPoint's own topmost check
    // uses (global.display.sort_windows_by_stacking) - and only that
    // window's own app (if it shares the slot with at least one other
    // window of the same wm_class) gets a strip. Confirmed live this is
    // the part that matters: showing a strip for *every* app that happens
    // to qualify in a shared slot, all stacked at once, included ones for
    // an app that wasn't even the one currently showing there - a slot
    // with several different apps round-robining together (not just extra
    // instances of one) only ever has one of them visible at a time to
    // begin with, so a strip for the others is labeling something that
    // isn't even what's on screen right now. A slot whose current window's
    // own app only has that one instance there gets no strip either - nothing
    // to switch between for what's actually showing, even if some *other*
    // app sharing the same slot would otherwise qualify.
    //
    // Every window sharing a slot still needs the same top margin
    // reserved, not just the ones in the currently-showing app's group -
    // they're genuinely stacked at the exact same position, so whichever
    // one ends up on top next (which can be any of them, the moment this
    // one is switched away from) would otherwise have the strip painted
    // straight over its own content the instant it does.
    //
    // Returns the list of groups (each {key, wmClass, windows, rect}, at
    // most one per shared rect) for _syncWindowTabStrips to turn into
    // actual widgets - computing that here, once, rather than a second
    // pass there, since this already has to walk every window in mg to
    // reserve the space.
    _reserveWindowTabSpace(mg, rects) {
        if (!this.windowTabsEnabled) return [];

        // A minimized window is removed from its manager entirely the
        // moment it minimizes (see _onWindowMinimizedChanged) - it has no
        // rect of its own here to share, only remembered so it can still
        // join whichever group its app's other windows already occupy,
        // rather than disappearing from the strip while minimized with no
        // way back into it short of the taskbar/window list.
        const minimizedHere = [];
        for (const [win, ownerMg] of this._minimizedWindowManager) {
            if (ownerMg === mg) minimizedHere.push(win);
        }

        // windowTabsMinWindows (schema min: 2 - a strip needs at least two
        // windows sharing a slot to have anything to switch between at
        // all).
        const minWindows = this.windowTabsMinWindows || 2;

        if (this.windowTabsGrouping === "all") return this._reserveSharedWindowTabSpace(mg, rects, minimizedHere, minWindows);

        const byRectKey = new Map();
        for (const [win, rect] of rects) {
            const rectKey = `${rect.x},${rect.y},${rect.w},${rect.h}`;
            if (!byRectKey.has(rectKey)) byRectKey.set(rectKey, []);
            byRectKey.get(rectKey).push(win);
        }

        // "By application" only tabs together windows of the *same* app
        // sharing a slot - two different apps forced to share one (a
        // "maximized" layout shares its single slot between everything,
        // or slavesMax rounding several apps onto one slot) stay
        // switchable only via Alt+Tab/the taskbar (or the "All open
        // windows" mode above).
        const groups = [];
        for (const [rectKey, wins] of byRectKey) {
            const topmost = global.display.sort_windows_by_stacking(wins).pop();
            const cls = topmost.get_wm_class() || "";
            const sameAppVisible = wins.filter((w) => (w.get_wm_class() || "") === cls);
            const sameAppMinimized = minimizedHere.filter((w) => (w.get_wm_class() || "") === cls);
            const sameApp = sameAppVisible.concat(sameAppMinimized);
            if (sameApp.length < minWindows) continue;

            const baseRect = rects.get(wins[0]);
            const baseX = baseRect.x,
                baseY = baseRect.y,
                baseW = baseRect.w,
                baseH = baseRect.h;
            const atBottom = this.windowTabsSide === "bottom";

            // Several windows sharing a slot share the exact same rect
            // *object* (Manager.compute() assigns one slot object to all of
            // them, see the s.forEach round-robin there) - adjust each
            // distinct rect object exactly once, tracked by identity, so
            // sharing it doesn't compound the same adjustment several times
            // over as this loop revisits it once per window.
            const adjusted = new Set();
            for (const w of wins) {
                const r = rects.get(w);
                if (adjusted.has(r)) continue;
                adjusted.add(r);
                if (!atBottom) r.y += WINDOW_TAB_STRIP_HEIGHT;
                r.h = Math.max(1, r.h - WINDOW_TAB_STRIP_HEIGHT);
            }

            const key = `${mg.workspaceIndex}:${mg.monitorIndex}:${rectKey}`;
            groups.push({
                key,
                wmClass: cls,
                windows: this._orderWindowTabGroup(key, sameApp),
                rect: { x: baseX, y: atBottom ? baseY + baseH - WINDOW_TAB_STRIP_HEIGHT : baseY, w: baseW, h: WINDOW_TAB_STRIP_HEIGHT },
            });
        }
        return groups;
    }

    // "All open windows" tab grouping: one strip for the *whole monitor*,
    // listing every window this manager tracks - master and every slave
    // alike - regardless of which of the layout's several distinct rects
    // each one actually sits in. The layout itself is untouched (ratios,
    // mastersMax/slavesMax, master/slave split all stay exactly as
    // computed) - only the rects that actually sit against the strip's own
    // edge of the monitor's bounding box (the top row when the strip is on
    // top, the bottom row when it's on the bottom) lose a
    // WINDOW_TAB_STRIP_HEIGHT sliver there to make room for it. Every rect
    // further down a stack (a second, third, ... slave stacked below the
    // first) isn't actually under the strip at all and is left completely
    // untouched. Confirmed live this distinction matters the moment a
    // slave stack has more than one row: shrinking *every* window's own
    // top unconditionally (the "maximized" layout's one-shared-rect case
    // this used to lean on - there, every window's rect *is* the same
    // object, so the distinction never came up) pushed each stacked slave
    // down by a full strip height without shrinking the rect above it to
    // compensate, opening a WINDOW_TAB_STRIP_HEIGHT gap - on top of the
    // ordinary configured gap - above every slave but the first.
    _reserveSharedWindowTabSpace(mg, rects, minimizedHere, minWindows) {
        const all = mg.allWindows();
        const combined = all.concat(minimizedHere);
        if (combined.length < minWindows) return [];

        const atBottom = this.windowTabsSide === "bottom";
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const w of all) {
            const r = rects.get(w);
            if (!r) continue;
            minX = Math.min(minX, r.x);
            maxX = Math.max(maxX, r.x + r.w);
            minY = Math.min(minY, r.y);
            maxY = Math.max(maxY, r.y + r.h);
        }
        if (!isFinite(minX)) return [];

        const adjusted = new Set();
        for (const w of all) {
            const r = rects.get(w);
            if (!r || adjusted.has(r)) continue;
            adjusted.add(r);
            if (atBottom) {
                if (r.y + r.h !== maxY) continue;
                r.h = Math.max(1, r.h - WINDOW_TAB_STRIP_HEIGHT);
            } else {
                if (r.y !== minY) continue;
                r.y += WINDOW_TAB_STRIP_HEIGHT;
                r.h = Math.max(1, r.h - WINDOW_TAB_STRIP_HEIGHT);
            }
        }

        const key = `${mg.workspaceIndex}:${mg.monitorIndex}:all`;
        return [
            {
                key,
                wmClass: "",
                windows: this._orderWindowTabGroup(key, combined),
                rect: { x: minX, y: atBottom ? maxY - WINDOW_TAB_STRIP_HEIGHT : minY, w: maxX - minX, h: WINDOW_TAB_STRIP_HEIGHT },
            },
        ];
    }

    // A user drag-reorder (see _commitWindowTabDragOrder) is remembered per
    // group key and re-applied here on every rebuild, persisted to disk
    // (see _saveWindowTabOrder) the same way a remembered layout is -
    // windows not, or no longer, covered by the saved order (a new arrival
    // since the last drag, or one that's since left the group) are appended
    // after whatever the saved order does cover, in whatever order they
    // arrive in here, rather than dropped.
    //
    // Also where a brand new tab ends up on the right rather than wherever
    // Manager's own masters/slaves arrays happen to put it: addWindow()
    // unshifts a newly tracked window to the *front* of whichever list it
    // joins (new window becomes master), which easily lands well before an
    // *older* window sitting later in the other list once there's more
    // than a couple - confirmed live opening
    // a third window landed its tab in the middle, ahead of the second
    // one's, not at the end. This result is always written back here
    // (not just a user's own explicit drag), so once a group's tab order
    // has been decided once, every window already in it keeps its spot and
    // only a genuinely new arrival - never yet covered by a saved order -
    // gets appended after everything else, regardless of where Manager's
    // own bookkeeping happened to insert it for tiling purposes.
    _orderWindowTabGroup(key, windows) {
        let saved = this._windowTabOrder.get(key);
        // First time this group's been rebuilt this session - a restart
        // (applet reload, Cinnamon restart) discards _windowTabOrder itself
        // (Meta.Window references from before don't survive it) but not
        // _pendingWindowTabOrder (stable_sequence numbers, loaded from disk
        // in the constructor) - resolve those back to this round's actual
        // windows once, the same "saved order, new arrivals appended after"
        // logic below then treats it exactly like a same-session saved order.
        if (!saved) {
            const pendingSeqs = this._pendingWindowTabOrder.get(key);
            if (pendingSeqs) {
                const byStableSeq = new Map(windows.map((w) => [w.get_stable_sequence(), w]));
                saved = pendingSeqs.map((seq) => byStableSeq.get(seq)).filter(Boolean);
            }
        }
        let ordered;
        if (!saved) {
            ordered = windows;
        } else {
            const current = new Set(windows);
            const savedSet = new Set(saved);
            ordered = saved.filter((w) => current.has(w));
            for (const w of windows) {
                if (!savedSet.has(w)) ordered.push(w);
            }
        }
        // Only worth writing to disk when a group's actual membership
        // changed (a window joined or left) - _saveWindowTabOrder rewrites
        // the whole settings file, and this runs on every retile, so
        // skipping it whenever nothing here actually changed keeps that
        // rare instead of happening on every focus change/window move.
        const previous = this._windowTabOrder.get(key);
        const changed = !previous || previous.length !== ordered.length;
        this._windowTabOrder.set(key, ordered);
        if (changed) this._saveWindowTabOrder();
        return ordered;
    }

    // Creates/updates/destroys the actual St widgets for this manager's
    // current tab groups - only ever touches entries whose key belongs to
    // this manager (the "ws:mon:" prefix _reserveWindowTabSpace builds
    // each key with), since _windowTabGroups is one shared map across every
    // manager and a bare "not seen this round" check would otherwise
    // destroy another manager's still-valid strips the moment *this*
    // manager retiles without them.
    _syncWindowTabStrips(mg, groups) {
        const mgPrefix = `${mg.workspaceIndex}:${mg.monitorIndex}:`;
        const seen = new Set();

        for (const g of groups) {
            seen.add(g.key);
            let entry = this._windowTabGroups.get(g.key);
            if (!entry) {
                const actor = new St.BoxLayout({ style_class: "kortile-window-tabs", reactive: true });
                actor.style = this._windowTabStripStyle();
                // Plain add_actor() alone does NOT make an actor receive
                // real input - Cinnamon's compositor overlay only
                // intercepts clicks within the region built from
                // Main.layoutManager's chrome-tracked actors (see
                // Chrome.updateRegions() in layout.js, which walks
                // this._trackedActors exclusively - a reactive actor that
                // was never addChrome/trackChrome'd is invisible to it).
                // Confirmed live: without this, clicks anywhere on a tab
                // button - icon or the padded background around it alike -
                // just passed straight through to the tiled window
                // underneath instead of reaching the button at all.
                // addToWindowgroup parents the actor into global.window_group
                // instead of addChrome's usual end-of-Main.uiGroup spot
                // (Chrome.addActor, layout.js) - same trick Cinnamon's own
                // TilePreview (windowManager.js) uses for its drag-to-snap
                // overlay. window_group is Main.uiGroup's own bottommost
                // child (every panel/menu/OSD is a sibling of it, never a
                // descendant - see the focus border's own setup in the
                // constructor), so anything living inside it - real window
                // actors and this one alike - already renders below all of
                // that automatically, no extra positioning needed the way
                // the old end-of-uiGroup addChrome placement needed (it used
                // to explicitly lower itself below each monitor's panel).
                // What it buys over that old placement is real stacking:
                // _restackWindowTabStrip below
                // places this actor as a sibling of the actual window
                // actors, directly above whichever of the group's own
                // windows is currently topmost, rather than unconditionally
                // above every window on the desktop - so a window
                // genuinely raised above the whole group (a floating one
                // the user drags there, or any other untracked window)
                // paints over it exactly like any other pair of overlapping
                // windows would, with no geometry-overlap bookkeeping
                // needed to hide the strip out of its way.
                Main.layoutManager.addChrome(actor, { affectsInputRegion: true, affectsStruts: false, addToWindowgroup: true });
                // wsIndex carried alongside the actor for
                // _updateWindowTabVisibility - Main.uiGroup isn't
                // workspace-scoped on its own (confirmed live: a strip for a
                // manager on an inactive workspace stayed fully visible on
                // screen, same as the focus border would if it didn't
                // explicitly check this itself), so nothing hides these when
                // their workspace isn't the one currently showing unless
                // something here does it explicitly.
                entry = { actor, buttons: new Map(), wsIndex: mg.workspaceIndex };
                this._windowTabGroups.set(g.key, entry);
            }
            // y is independent of the button set below; x depends on the
            // strip's natural width (windowTabsPosition), so it's set only
            // after that's settled, below. Kept on the entry too (not just
            // used locally here) so _onWindowTitleChanged's own lighter-
            // weight refresh can recompute x for a width change without
            // needing a full retile just to get g.rect back.
            entry.rect = g.rect;
            entry.actor.set_y(g.rect.y);

            const current = new Set(g.windows);
            for (const [win, btn] of Array.from(entry.buttons)) {
                if (current.has(win)) continue;
                entry.actor.remove_actor(btn);
                btn.destroy();
                entry.buttons.delete(win);
            }
            g.windows.forEach((win, index) => {
                let btn = entry.buttons.get(win);
                if (btn) {
                    // Still the same window, but its title (and therefore
                    // the tooltip, and the label in icons-titles style) can
                    // change on its own at any time - a VSCodium window's
                    // title changes with whatever file is open in it, for
                    // instance - without the group's own membership ever
                    // changing, which is the only thing that would
                    // otherwise trigger this loop to touch it again.
                    this._refreshWindowTabButton(btn, win);
                } else {
                    btn = this._createWindowTabButton(win, g.key);
                    entry.actor.add_actor(btn);
                    entry.buttons.set(win, btn);
                }
                // g.windows is already in the right order (natural, or a
                // saved drag-reorder - see _orderWindowTabGroup) - except
                // while this exact group is mid-drag (_windowTabDragGroupKey),
                // where the live swap already driving the actor tree directly
                // (_updateWindowTabDragPosition) is the current source of
                // truth instead, since nothing has been committed to
                // _windowTabOrder yet for this to even read.
                if (this._windowTabDragGroupKey !== g.key) {
                    entry.actor.set_child_at_index(btn, index);
                }
            });

            this._layoutWindowTabStrip(entry);
            this._restackWindowTabStrip(entry);
        }

        for (const [key, entry] of Array.from(this._windowTabGroups)) {
            if (!key.startsWith(mgPrefix) || seen.has(key)) continue;
            entry.actor.destroy();
            this._windowTabGroups.delete(key);
        }

        this._updateWindowTabHighlights();
        this._updateWindowTabVisibility();
    }

    // See the comment where wsIndex gets stored on an entry, above - a
    // manager's own workspace not being the currently active one is the
    // *usual* case here (most managers on other workspaces aren't being
    // looked at right now), so this hides far more than it shows most of
    // the time. -1 (see _isWorkspaceIndependentMonitor) is always visible,
    // same reasoning as everywhere else that sentinel means "not really
    // tied to a specific workspace".
    _updateWindowTabVisibility() {
        const activeWs = global.workspace_manager.get_active_workspace_index();
        for (const entry of this._windowTabGroups.values()) {
            const onActiveWorkspace = entry.wsIndex === -1 || entry.wsIndex === activeWs;
            if (onActiveWorkspace) entry.actor.show();
            else entry.actor.hide();
        }
    }

    // Keeps a strip's actual Clutter stacking position in sync with real
    // window stacking, now that it lives in global.window_group (see
    // addToWindowgroup in _syncWindowTabStrips) instead of always-on-top
    // chrome: placed directly above whichever of its own group's windows is
    // currently topmost (usually whichever tab _activateAndRaise last
    // raised), the same "topmost of the group" _reserveWindowTabSpace
    // itself already uses to decide which app's tabs to show. Anything
    // genuinely raised above that - a floating window the user drags there,
    // or any other window kortile never tracked at all - then paints over
    // the strip exactly like it would over any other window sharing that
    // z-order, with no geometry-overlap bookkeeping needed to hide the
    // whole strip out of its way. Falls back to the very top of
    // window_group when nothing in the group has a live compositor actor to
    // anchor against (every member currently minimized, say) - there's
    // nothing real tiled there right now for it to hide behind anyway.
    _restackWindowTabStrip(entry) {
        const topmost = this._topmostGroupWindow(entry);
        if (!topmost) {
            global.window_group.set_child_above_sibling(entry.actor, null);
            return;
        }
        global.window_group.set_child_above_sibling(entry.actor, topmost.get_compositor_private());
    }

    // Shared by _restackWindowTabStrip (z-order) and _windowTabStripRect
    // (layout) - whichever of a group's own windows is currently topmost in
    // real stacking order, the same one _reserveWindowTabSpace itself
    // already uses to decide which app's tabs to show. null when nothing in
    // the group has a live compositor actor to anchor against (every member
    // currently minimized, say).
    _topmostGroupWindow(entry) {
        const candidates = [];
        for (const win of entry.buttons.keys()) {
            if (win.minimized) continue;
            if (win.get_compositor_private()) candidates.push(win);
        }
        if (candidates.length === 0) return null;
        return global.display.sort_windows_by_stacking(candidates).pop();
    }

    // A user-set name (double-click a tab in "Icons with titles" style, see
    // _startWindowTabRename) overrides the window's own title everywhere a
    // tab shows text for it - label and tooltip alike - until cleared
    // (empty rename) or the window closes; it's kept in memory only
    // (_windowTabCustomNames), same as every other per-window Map here, so
    // it never survives past that window's own lifetime.
    _windowTabDisplayTitle(win) {
        return this._windowTabCustomNames.get(win) || win.get_title() || "";
    }

    _windowTabTitle(win) {
        const t = this._windowTabDisplayTitle(win);
        return t.length > WINDOW_TAB_TITLE_MAX_CHARS ? `${t.slice(0, WINDOW_TAB_TITLE_MAX_CHARS - 1)}…` : t;
    }

    _createWindowTabButton(win, groupKey) {
        const app = Cinnamon.WindowTracker.get_default().get_window_app(win);
        const icon = app
            ? app.create_icon_texture(WINDOW_TAB_ICON_SIZE)
            : new St.Icon({ icon_name: "application-x-executable", icon_size: WINDOW_TAB_ICON_SIZE });

        let child = icon;
        let label = null;
        let box = null;
        if (this.windowTabsStyle === "icons-titles") {
            label = new St.Label({ text: this._windowTabTitle(win) });
            label.style = `font-size: 0.9em; color: ${this._windowTabForegroundHex()};`;
            box = new St.BoxLayout();
            box.style = "spacing: 5px;";
            box.add_actor(icon);
            box.add_actor(label);
            child = box;
        }

        const btn = new St.Button({ child, style_class: "kortile-window-tab", reactive: true, track_hover: true });
        // Stretch mode: the strip itself already spans the slot's full
        // width (see _layoutWindowTabStrip) - x_expand is what makes the
        // *tabs* share that width out evenly between them (BoxLayout
        // distributes leftover space among expanding children) instead of
        // sitting at their natural size with empty space past the last
        // one. x_fill stays false regardless - the button's own child
        // (icon, or icon+label box in icons-titles style) keeps its
        // natural, compact size and x_align centers it within whatever
        // extra width x_expand gave the button, rather than the child
        // itself stretching edge-to-edge and leaving icon+label pinned to
        // its left side. St.Bin (St.Button's parent class) declares its
        // own legacy "x-align" property typed St.Align (START/MIDDLE/END =
        // 0/1/2), shadowing Clutter.Actor's modern same-named property
        // (Clutter.ActorAlign: FILL/START/CENTER/END = 0/1/2/3) - confirmed
        // live that Clutter.ActorAlign.CENTER here silently lands as raw
        // integer 2, which St.Align reads back as END, not MIDDLE.
        btn.x_expand = !!this.windowTabsStretch;
        btn.x_fill = false;
        btn.x_align = St.Align.MIDDLE;
        btn._kortileWin = win;
        btn._kortileGroupKey = groupKey;
        btn._kortileLabel = label;
        // Only set in icons-titles style (where box/label exist at all) -
        // _startWindowTabRename swaps the entry it needs in and out of this
        // same box rather than rebuilding the button.
        btn._kortileBox = box;
        btn._kortileHovered = false;
        btn._kortileEditing = false;
        btn._kortileLastClickTime = undefined;
        btn._kortileDragStart = null;
        btn._kortileDragging = false;
        btn._kortileDragWatchdog = null;
        this._restyleWindowTabButton(btn);

        // St.Button's own track_hover only drives *theme* (stylesheet.css)
        // pseudo-classes, which this applet has none of - it never touches
        // the inline `style` string this uses instead (see
        // _restyleWindowTabButton), so hover needs its own explicit state.
        btn.connect("enter-event", () => {
            btn._kortileHovered = true;
            this._restyleWindowTabButton(btn);
        });
        btn.connect("leave-event", () => {
            btn._kortileHovered = false;
            this._restyleWindowTabButton(btn);
        });
        // Click, double-click and drag-to-reorder all start the same way (a
        // left button-press) and only tell apart once the pointer either
        // moves past WINDOW_TAB_DRAG_THRESHOLD (a drag, see
        // _startWindowTabDrag) or comes back up again without having done
        // so (a click) - handled together, rather than leaning on St.Button's
        // own "clicked", so the two can't race or double-fire against each
        // other reacting to the same press/release pair independently.
        // While already mid-rename, a press landing back on the button
        // (e.g. positioning the cursor in its own entry) does none of this.
        // Middle-click closes the window outright instead - same convention
        // browser tabs use - handled on press rather than waiting for
        // release like the left button does above: there's no drag to
        // distinguish it from here, so nothing to gain by waiting.
        btn.connect("button-press-event", (actor, event) => {
            if (btn._kortileEditing) return Clutter.EVENT_PROPAGATE;
            const button = event.get_button();
            if (button === 2) {
                if (win.can_close()) win.delete(global.get_current_time());
                return Clutter.EVENT_STOP;
            }
            if (button !== 1) return Clutter.EVENT_PROPAGATE;
            btn._kortileDragStart = event.get_coords();
            btn._kortileDragging = false;
            event.get_device().grab(btn);
            return Clutter.EVENT_STOP;
        });
        btn.connect("motion-event", (actor, event) => {
            if (!btn._kortileDragStart) return Clutter.EVENT_PROPAGATE;
            this._onWindowTabDragMotion(btn, win, event);
            return Clutter.EVENT_STOP;
        });
        btn.connect("button-release-event", (actor, event) => {
            if (!btn._kortileDragStart) return Clutter.EVENT_PROPAGATE;
            this._finishWindowTabInteraction(btn, win, event.get_device());
            return Clutter.EVENT_STOP;
        });
        // Defensive: if this button is ever destroyed mid-drag (its window
        // closed, or the whole strip torn down by a settings change) rather
        // than through a normal release, _windowTabDragGroupKey would
        // otherwise permanently point at a dead group - leaving every
        // future rebuild of it skipping the order-enforcement step above
        // forever, since nothing would ever clear it again. Same idea for
        // the drag watchdog's own timer (_startWindowTabDragWatchdog) -
        // its own "still dragging?" check already bails safely once
        // _kortileDragStart is cleared, but only the *next* tick would
        // notice that on its own; this cancels it outright instead of
        // leaving a firing-then-no-op timer around until then.
        btn.connect("destroy", () => {
            if (this._windowTabDragGroupKey === btn._kortileGroupKey) this._windowTabDragGroupKey = null;
            if (btn._kortileDragWatchdog) {
                GLib.source_remove(btn._kortileDragWatchdog);
                btn._kortileDragWatchdog = null;
            }
        });

        // Tooltip::_init hooks its own enter/leave/destroy on btn - shows
        // the full (untruncated) title even in icons-titles style, and is
        // the only way to see it at all in the default icons-only style.
        btn._kortileTooltip = new Tooltips.Tooltip(btn, this._windowTabDisplayTitle(win));

        return btn;
    }

    // Manual double-click detection: St.Button has no click-count of its
    // own to read, so this just compares consecutive "clicked" timestamps
    // against a fixed threshold instead.
    _isWindowTabDoubleClick(btn) {
        const now = global.get_current_time();
        const last = btn._kortileLastClickTime;
        btn._kortileLastClickTime = now;
        return last !== undefined && now >= last && now - last < 400;
    }

    // Fires on every pointer move once a button is pressed (event.get_device()
    // .grab(btn) in the button-press-event handler above redirects them here
    // regardless of where the pointer actually is by now, same primitive
    // Cinnamon's own slider.js drags a handle with - unlike a tiled window's
    // own drag/swap, real Clutter motion events are exactly what's needed
    // here and reliable for it, this being a plain in-process UI actor
    // rather than an external client window Mutter is separately grabbing).
    // Past WINDOW_TAB_DRAG_THRESHOLD from the press, this is a drag, not a
    // click - past that point every further move live-swaps this button
    // with whichever neighbor it's crossed the midpoint of, at most one
    // step per event (successive events during the same drag cascade this
    // into a full reorder, same idea a lot of simple drag-reorder UIs use
    // rather than computing a final target index in one shot).
    _onWindowTabDragMotion(btn, win, event) {
        const [sx, sy] = btn._kortileDragStart;
        const [x, y] = event.get_coords();
        if (!btn._kortileDragging) {
            if (Math.hypot(x - sx, y - sy) < WINDOW_TAB_DRAG_THRESHOLD) return;
            btn._kortileDragging = true;
            btn.set_opacity(180);
            this._windowTabDragGroupKey = btn._kortileGroupKey;
            this._startWindowTabDragWatchdog(btn, win);
        }

        const parent = btn.get_parent();
        if (!parent) return;
        const siblings = parent.get_children();
        const myIndex = siblings.indexOf(btn);
        if (myIndex < 0) return;

        const prev = siblings[myIndex - 1];
        if (prev) {
            const [px] = prev.get_transformed_position();
            const [pw] = prev.get_transformed_size();
            if (x < px + pw / 2) {
                parent.set_child_at_index(btn, myIndex - 1);
                return;
            }
        }
        const next = siblings[myIndex + 1];
        if (next) {
            const [nx] = next.get_transformed_position();
            const [nw] = next.get_transformed_size();
            if (x > nx + nw / 2) {
                parent.set_child_at_index(btn, myIndex + 1);
            }
        }
    }

    // Drag released past the threshold (see _onWindowTabDragMotion): the
    // live reordering already done during the drag is already the strip's
    // actual on-screen state, this just makes it stick - reads the actor
    // tree's own final child order back out (already right there in
    // front-to-back == left-to-right order, same order set_child_at_index
    // was just driving) and remembers it for _reserveWindowTabSpace
    // (_orderWindowTabGroup) to re-apply on every future rebuild, persisted
    // to disk (_saveWindowTabOrder) so an explicit drag survives a restart
    // same as it survives any other retile.
    _commitWindowTabDragOrder(btn, win) {
        btn.set_opacity(255);
        const parent = btn.get_parent();
        if (!parent || !btn._kortileGroupKey) return;
        const order = parent.get_children().map((child) => child._kortileWin);
        this._windowTabOrder.set(btn._kortileGroupKey, order);
        this._saveWindowTabOrder();
        this._windowTabDragGroupKey = null;
        const mg = this._managerFor(win);
        if (mg) this._retile(mg);
    }

    // Safety net for a real bug confirmed live: repeatedly calling
    // set_child_at_index() on the *grabbed* actor itself mid-drag
    // (_onWindowTabDragMotion, swapping it past more than one neighbor in a
    // single drag) can silently break the event.get_device().grab() from
    // button-press-event partway through - button-release-event then never
    // fires on this button again, leaving it stuck mid-drag (dimmed,
    // _kortileDragStart still set) forever, with nothing left to end it.
    // Confirmed the grab itself is what's actually gone, not just this
    // button failing to notice: _pointerButtonHeld() (the same real,
    // reliable pointer-state read _onWindowGeometryChanged's own drag
    // detection already depends on, unlike Mutter's own unreliable grab-op
    // signals) reports the button already back up. Polling it here is a
    // deliberate fallback for exactly that gap, not the primary path -
    // finishes the drag as soon as it disagrees with what this button
    // still thinks is happening, same outcome a normal release would have
    // reached.
    _startWindowTabDragWatchdog(btn, win) {
        if (btn._kortileDragWatchdog) return;
        btn._kortileDragWatchdog = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            if (!btn._kortileDragStart) {
                btn._kortileDragWatchdog = null;
                return GLib.SOURCE_REMOVE;
            }
            if (this._pointerButtonHeld()) return GLib.SOURCE_CONTINUE;
            btn._kortileDragWatchdog = null;
            this._finishWindowTabInteraction(btn, win, null);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Shared end-of-interaction path for both a normal button-release-event
    // and the drag watchdog's own fallback above (which has no release
    // event of its own to hand in - device is null there, ungrab() already
    // moot by the time _pointerButtonHeld() disagrees with this button).
    _finishWindowTabInteraction(btn, win, device) {
        if (!btn._kortileDragStart) return;
        if (device) {
            try {
                device.ungrab();
            } catch (e) {
                // already gone
            }
        }
        if (btn._kortileDragWatchdog) {
            GLib.source_remove(btn._kortileDragWatchdog);
            btn._kortileDragWatchdog = null;
        }
        btn._kortileDragStart = null;
        const wasDragging = btn._kortileDragging;
        btn._kortileDragging = false;
        if (wasDragging) {
            this._commitWindowTabDragOrder(btn, win);
            return;
        }
        // No real movement happened - same click/double-click behavior as
        // before: raises and focuses without touching geometry, no
        // different from switching to any other tracked window, unless
        // this is the second click of a double-click, which renames
        // instead (see _startWindowTabRename). A single click on a tab
        // that's already the focused window minimizes it instead of
        // re-activating a no-op focus change - same convention a taskbar's
        // own click-to-toggle already uses, and the only way this tab is
        // even reachable to click again in the first place (a
        // not-currently-shown tab in the same group is switched *to*, not
        // minimized, by this same click - see _activateAndRaise).
        if (this._isWindowTabDoubleClick(btn)) {
            this._startWindowTabRename(btn, win);
        } else if (win === global.display.focus_window) {
            win.minimize();
        } else {
            this._activateAndRaise(win);
        }
    }

    // Double-click (see _isWindowTabDoubleClick) on a tab in "Icons with
    // titles" style swaps its label for an editable St.Entry in place,
    // pre-filled with its current name - only meaningful there since
    // icons-only style has no label/box for it to appear in at all.
    _startWindowTabRename(btn, win) {
        if (this.windowTabsStyle !== "icons-titles" || !btn._kortileBox || !btn._kortileLabel) return;
        if (btn._kortileEditing) return;
        btn._kortileEditing = true;

        if (btn._kortileTooltip) {
            btn._kortileTooltip.preventShow = true;
            btn._kortileTooltip.hide();
        }

        const entry = new St.Entry({ text: this._windowTabDisplayTitle(win) });
        // min-width is deliberately more than most titles' own natural
        // width (some headroom to type a longer new name without the strip
        // visibly reflowing on every keystroke), but 120px used to apply
        // regardless of how short the tab was to begin with - confirmed
        // live an icons-only-length tab (a couple characters, well under
        // this) jumped dramatically wider than its neighbors the instant
        // rename started, purely from this floor, not anything the actual
        // typing needed yet. 70px is still headroom, just not an
        // exaggerated jump for a short tab. border/box-shadow/background
        // reset to blank - confirmed live the active Cinnamon theme's own
        // default StEntry chrome (a bordered, slightly glowing input-field
        // look) still applied despite no style_class being set here,
        // clashing with the tab's own plain flat-highlight look.
        entry.style = `font-size: 0.9em; color: ${this._windowTabForegroundHex()}; min-width: 70px; border: none; box-shadow: none; background-color: transparent; padding: 0;`;
        btn._kortileEntry = entry;
        btn._kortileLabel.hide();
        btn._kortileBox.add_actor(entry);

        // Enter commits; Escape cancels (reverts to whatever name was
        // showing before this rename started, discarding what was typed).
        entry.clutter_text.connect("activate", () => this._commitWindowTabRename(btn, win));
        entry.connect("key-press-event", (actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._cancelWindowTabRename(btn, win);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // A plain addChrome actor's own grab_key_focus() alone never
        // actually receives typed characters - confirmed live (this is
        // exactly the bug just reported: the entry appeared, but nothing
        // typed into it went anywhere). Cinnamon/Mutter still routes raw
        // keyboard input straight to whichever *window* holds real focus
        // unless the stage itself is holding a modal grab redirecting all
        // input through it instead - the same reason _startWindowPicker
        // needs one for its own Escape handling, just here for every key,
        // not only Escape. Main.pushModal's FULLSCREEN input mode grabs
        // the pointer too, so a click landing anywhere outside the entry
        // has to be caught and handled here instead of relying on
        // key-focus-out, which a modal grab holding the entry's focus
        // throughout means never naturally fires from clicking elsewhere.
        Main.pushModal(entry);
        btn._kortileCapturedId = global.stage.connect("captured-event", (actor, event) =>
            this._onWindowTabRenameEvent(btn, win, event)
        );
        // Defensive: pushModal already auto-pops itself if its own actor is
        // destroyed (see main.js), but that doesn't know about the captured-
        // event listener above - if this entry is ever torn down some other
        // way mid-rename (window closed, tab strip rebuilt by a style
        // change) rather than through _endWindowTabRename, this still stops
        // it firing forever against a dead entry instead of leaking it.
        entry.connect("destroy", () => this._cleanupWindowTabRenameCapture(btn));

        entry.grab_key_focus();
        entry.clutter_text.set_selection(0, entry.get_text().length);
    }

    _cleanupWindowTabRenameCapture(btn) {
        if (!btn._kortileCapturedId) return;
        try {
            global.stage.disconnect(btn._kortileCapturedId);
        } catch (e) {
            // already gone
        }
        btn._kortileCapturedId = null;
    }

    // Only intercepts a click landing outside the entry (commits, same as
    // losing focus would elsewhere - typing a name and clicking away from
    // it reads as "done", not "never mind"); everything else, typed keys
    // above all, is left alone to reach the entry normally.
    _onWindowTabRenameEvent(btn, win, event) {
        if (event.type() !== Clutter.EventType.BUTTON_PRESS) return Clutter.EVENT_PROPAGATE;
        const entry = btn._kortileEntry;
        if (entry && entry.contains(event.get_source())) return Clutter.EVENT_PROPAGATE;
        this._commitWindowTabRename(btn, win);
        return Clutter.EVENT_STOP;
    }

    // An empty name clears the override (falls back to the window's own
    // title again) rather than being kept as a literal empty string - an
    // empty tab label would be indistinguishable from a bug.
    _commitWindowTabRename(btn, win) {
        if (!btn._kortileEditing) return;
        btn._kortileEditing = false;
        const text = btn._kortileEntry.get_text().trim();
        if (text) this._windowTabCustomNames.set(win, text);
        else this._windowTabCustomNames.delete(win);
        this._endWindowTabRename(btn, win);
    }

    _cancelWindowTabRename(btn, win) {
        if (!btn._kortileEditing) return;
        btn._kortileEditing = false;
        this._endWindowTabRename(btn, win);
    }

    // Common teardown for both commit and cancel: release the modal grab,
    // drop the entry, restore the label, and refresh/retile so a changed
    // name's width is reflected immediately rather than waiting for the
    // next unrelated retile.
    _endWindowTabRename(btn, win) {
        // Same defensive try/catch as _stopWindowPicker: popModal can throw
        // ("incorrect pop") if the modal stack was disturbed by something
        // else in the meantime - still tear down the rest of this state
        // either way so a stuck rename can't wedge every tab strip behind it.
        try {
            Main.popModal(btn._kortileEntry);
        } catch (e) {
            global.logWarning(`[${this.uuid}] error closing tab rename: ${e}`);
        }
        this._cleanupWindowTabRenameCapture(btn);
        btn._kortileEntry.destroy();
        btn._kortileEntry = null;
        btn._kortileLabel.show();
        if (btn._kortileTooltip) btn._kortileTooltip.preventShow = false;
        this._refreshWindowTabButton(btn, win);
        const mg = this._managerFor(win);
        if (mg) this._retile(mg);
    }

    // Title (and therefore tooltip/label) can change without the button
    // itself needing to be rebuilt - see the call site in
    // _syncWindowTabStrips.
    _refreshWindowTabButton(btn, win) {
        if (btn._kortileTooltip) btn._kortileTooltip.set_text(this._windowTabDisplayTitle(win));
        if (btn._kortileLabel) btn._kortileLabel.set_text(this._windowTabTitle(win));
        // Keeps an existing (reused, not recreated) button in sync if
        // windowTabsStretch was toggled since it was created - see
        // _createWindowTabButton.
        btn.x_expand = !!this.windowTabsStretch;
    }

    // win's own title just changed (see the notify::title connection in
    // _attachWindowSignals) - a full _retile(mg) would also pick this up,
    // same as any other retile trigger does via the loop in
    // _syncWindowTabStrips, but titles on some apps change often enough
    // (a shell prompt retitling itself per command, say) that doing the
    // whole manager's geometry/rect/tab-group bookkeeping over again just
    // for this would be wasteful - this only touches the one button
    // actually showing this window's title, wherever it is, plus the
    // strip's own width/x if that button's group is currently the one
    // showing (an unshown one's button still exists and gets kept in sync
    // the same way, just doesn't need a visible reposition for it - its
    // own group's strip already stayed hidden throughout via
    // _updateWindowTabVisibility, unaffected by any of this).
    _onWindowTitleChanged(win) {
        if (!this.windowTabsEnabled) return;
        for (const entry of this._windowTabGroups.values()) {
            const btn = entry.buttons.get(win);
            if (!btn) continue;
            this._refreshWindowTabButton(btn, win);
            this._layoutWindowTabStrip(entry);
            return;
        }
    }

    // windowTabsStretch off (default): the strip is only as wide as its
    // tabs need, positioned per windowTabsPosition. On: it always spans
    // the slot's full width instead - set_width(-1) first clears any
    // fixed width a *previous* sync left behind (Clutter's own convention
    // for "go back to natural sizing"), needed for toggling the setting
    // back off to actually shrink the strip again rather than leaving it
    // stuck at whatever width stretch mode last forced. Uses
    // _windowTabStripRect (the group's real, currently-topmost window
    // width) rather than entry.rect (the slot kortile originally asked for)
    // - see there for why those two can differ.
    _layoutWindowTabStrip(entry) {
        if (!entry.rect) return;
        const rect = this._windowTabStripRect(entry);
        if (this.windowTabsStretch) {
            entry.actor.set_width(rect.w);
            entry.actor.set_x(rect.x);
            this._equalizeWindowTabWidths(entry, rect);
        } else {
            entry.actor.set_width(-1);
            for (const btn of entry.buttons.values()) btn.set_width(-1);
            const [, naturalWidth] = entry.actor.get_preferred_width(-1);
            entry.actor.set_x(computeWindowTabStripX(rect.x, rect.w, naturalWidth, this.windowTabsPosition));
        }
    }

    // A VTE-based terminal (gnome-terminal among them) rounds a requested
    // resize down to a whole number of character cells before actually
    // applying it - its real frame_rect can end up narrower than the slot
    // kortile asked for, with nothing left to notice or correct (the app
    // itself decided the final size, not a stubborn-app fight kortile can
    // re-assert its way out of - see _commitGeometryChange). Confirmed live
    // this left the strip visibly wider than the window sitting under it,
    // out of step with the focus border, which already tracks the real
    // window (win.get_frame_rect(), live) rather than the slot. Anchoring
    // the strip to that same real rect instead keeps both of them agreeing
    // with each other and with the window itself. Falls back to the slot's
    // own rect (entry.rect) when there's no live window to measure - same
    // case _topmostGroupWindow itself already returns null for.
    _windowTabStripRect(entry) {
        const topmost = this._topmostGroupWindow(entry);
        if (!topmost) return entry.rect;
        const r = topmost.get_frame_rect();
        return { x: r.x, y: entry.rect.y, w: r.width, h: entry.rect.h };
    }

    // Stretch mode used to just give every tab an equal *share of leftover*
    // space on top of its own natural width (Clutter's own x_expand
    // distribution, x_fill left off) - confirmed live that still left tabs
    // of visibly different width whenever there was a lot of room to fill,
    // since a wide natural tab and a narrow one both grew by the same flat
    // amount rather than ending up the same final size. This instead makes
    // every tab in the strip exactly the same width once there's enough
    // spare room for all of them to comfortably fit - true equal columns,
    // not equal *growth*. Below that threshold (many/long tabs already
    // needing more room than the strip has), every tab keeps its own
    // natural size instead and the strip overflows exactly like it always
    // has, rather than cramming everyone into an equally-too-small column -
    // that's also the one regime with the least leftover room to look
    // inconsistent about in the first place.
    _equalizeWindowTabWidths(entry, rect) {
        const buttons = Array.from(entry.buttons.values());
        if (buttons.length === 0) return;
        for (const btn of buttons) btn.set_width(-1);
        // entry.actor's own width was just forced to the slot's full width
        // by the caller (_layoutWindowTabStrip) above - querying its
        // preferred width without clearing that override first would just
        // echo the fixed width straight back (Clutter honors an explicit
        // set_width() as an actor's own preferred size from then on), not
        // the natural sum this needs to compare against.
        entry.actor.set_width(-1);
        const naturals = buttons.map((btn) => btn.get_preferred_width(-1)[1]);
        const naturalTotal = naturals.reduce((a, b) => a + b, 0);
        const [, stripNatural] = entry.actor.get_preferred_width(-1);
        const available = rect.w;
        entry.actor.set_width(available);
        if (stripNatural >= available) return;
        const overhead = stripNatural - naturalTotal; // the strip's own spacing/padding, same regardless of any one tab's width
        const equalWidth = Math.floor((available - overhead) / buttons.length);
        for (const btn of buttons) btn.set_width(equalWidth);
    }

    // Restyles a single button (its own focus/hover state changing) or, if
    // called with no argument, every button in every group (an actual
    // focus-window change - see _onFocusWindowChanged - where which
    // button *should* be highlighted has changed, not just this one's own
    // hover state).
    _restyleWindowTabButton(btn) {
        const focused = btn._kortileWin === global.display.focus_window;
        // The focused tab's own highlight already shows which window is
        // current - a tooltip repeating its title on hover is redundant
        // there (every *other* tab still gets one; it's the only place to
        // see an icons-only tab's full untruncated title at all). Also
        // force-hides it immediately: preventShow alone only blocks a
        // *future* show, so without this, a tooltip already on screen from
        // hovering just before the button became focused (e.g. clicking
        // it) would otherwise sit there stuck open.
        if (btn._kortileTooltip) {
            btn._kortileTooltip.preventShow = focused;
            if (focused) btn._kortileTooltip.hide();
        }
        const alpha = focused ? 0.28 : btn._kortileHovered ? 0.16 : 0.06;
        const bg = this._windowTabForegroundRgba(alpha);
        btn.style = `padding: ${WINDOW_TAB_BUTTON_PADDING}px; border-radius: 3px; background-color: ${bg};`;
    }

    // Called after every retile (via _syncWindowTabStrips) and on every
    // focus change (see _onFocusWindowChanged), same two triggers the
    // focus border itself reacts to.
    _updateWindowTabHighlights() {
        for (const entry of this._windowTabGroups.values()) {
            for (const btn of entry.buttons.values()) this._restyleWindowTabButton(btn);
        }
    }

    _destroyAllWindowTabStrips() {
        for (const entry of this._windowTabGroups.values()) entry.actor.destroy();
        this._windowTabGroups.clear();
    }

    _applyRects(rects) {
        for (const [win, rect] of rects) {
            this._applyOne(win, rect, true);
        }
    }

    // Applies one window's target rect: move+resize, a position-only nudge
    // fallback, an optional slide animation, and a permanent Clutter clip
    // sized to the *slot* (not the window's own reported size) so that a
    // window fighting the tile (see _commitGeometryChange) can never
    // visually spill into a neighboring tile even between corrections -
    // its content is cropped to the slot bounds no matter what size the
    // window itself insists on internally.
    _applyOne(win, rect, animate) {
        const x = Math.round(rect.x);
        const y = Math.round(rect.y);
        const w = Math.max(1, Math.round(rect.w));
        const h = Math.max(1, Math.round(rect.h));

        // Safety net for the slide animation below: it always either
        // starts a fresh ease back to 0 or leaves an existing one running,
        // so translation_x/y should never sit at a nonzero value with no
        // transition actually driving it towards 0. Confirmed live it can
        // anyway - several retiles landing on the same window in rapid
        // succession (well under the 200ms ease duration apart, e.g. a
        // layout flipped and flipped right back within one synchronous
        // burst) computed a translation from an actor.x/y read that was
        // itself still catching up from the *previous* one of those
        // retiles, producing a large, wrong offset whose ease() call never
        // actually got scheduled - the window then sat rendered far from
        // its real position indefinitely, with nothing else left to ever
        // touch it again once its frame rect stopped changing. Whatever
        // the exact cause, a stuck offset with no transition behind it is
        // never correct - snap it back before doing anything else, on
        // every call, not only the ones that go on to move the window.
        const actorForCleanup = win.get_compositor_private();
        if (actorForCleanup) {
            if (actorForCleanup.translation_x !== 0 && !actorForCleanup.get_transition("translation-x")) {
                actorForCleanup.translation_x = 0;
            }
            if (actorForCleanup.translation_y !== 0 && !actorForCleanup.get_transition("translation-y")) {
                actorForCleanup.translation_y = 0;
            }
        }

        // _retile() recomputes and reapplies every window in the manager,
        // even when the only thing that actually changed is unrelated to
        // most of them - a focus change deciding which app's tab strip
        // should show (see _onFocusWindowChanged) recomputes the *whole*
        // manager just to re-derive that, same target rects as before for
        // every window not actually involved. Without this, each of them
        // still got a real move_resize_frame() call - and a fresh
        // _applyClipWhenSettled poll cycle, at least 2 ticks/50ms each
        // since that now waits for the actor to prove it's genuinely
        // stable - purely to land back exactly where it already was.
        // Confirmed live this is what made focusing into a slot shared
        // with several other windows visibly slower the more of them
        // there were: not the tab strip UI itself, the redundant real
        // geometry work for every *other* window in that same manager on
        // every single focus change. Only short-circuits when the window
        // is already actually sitting where it's being asked to - a window
        // that's currently maximized always goes through in full
        // regardless, so it still gets unmaximized below even if the tile
        // rect underneath hasn't itself changed.
        //
        // "Already sitting where it's being asked to" is judged against
        // _lastAppliedRect (what Mutter actually settled the frame at last
        // time, read back post-move below), not the bare request - an app
        // whose own size hints won't let it land on an arbitrary pixel size
        // (gnome-terminal is the reported case: WM_SIZE_HINTS resize
        // increments quantize it to whole character-cell rows, so a slot
        // height that isn't itself a multiple of one row settles a few px
        // short) would otherwise never match the exact request and so never
        // short-circuit - re-issuing an identical move_resize_frame() on
        // every single retile even though nothing meaningful changed, which
        // for such an app is visible as its own height wobbling on every
        // focus change even while the computed tile target never moved.
        // _lastRequestedRect (the bare ask, tracked separately from what
        // actually landed) is what still catches a *genuinely* new target -
        // only the reality check below is against what really landed, not
        // what was asked for. This doesn't close the underlying few-px gap
        // itself (that's the app's own size hints, outside this applet's
        // control), just the repeated re-application of it.
        const lastRequested = this._lastRequestedRect.get(win);
        const requestUnchanged =
            lastRequested && lastRequested.x === x && lastRequested.y === y && lastRequested.w === w && lastRequested.h === h;
        this._lastRequestedRect.set(win, { x, y, w, h });
        const last = this._lastAppliedRect.get(win);
        if (win.get_maximized() === 0 && requestUnchanged && last) {
            const cur = win.get_frame_rect();
            if (cur.x === last.x && cur.y === last.y && cur.width === last.w && cur.height === last.h) return;
        }

        if (win.get_maximized() !== 0) {
            win.unmaximize(Meta.MaximizeFlags.BOTH);
        }

        const actor = win.get_compositor_private();
        const beforeX = actor ? actor.x : null;
        const beforeY = actor ? actor.y : null;
        const beforeFrame = win.get_frame_rect();

        // Move+resize together first, so Mutter's constraint solver sees
        // the final target atomically. Doing a position-only move_frame
        // *first* (moving while still at the old size) was tried as a
        // workaround for the case below, but backfires the other way:
        // shrinking-and-moving-right (e.g. becoming the vertical-right
        // master) would push the still-oversized window off-screen for
        // that one call, so Mutter clamped X back to fit the old size,
        // and that clamped position stuck - causing a runaway jitter
        // loop as commitGeometryChange kept "fixing" the result.
        win.move_resize_frame(true, x, y, w, h);

        // Only if that didn't fully take (e.g. the requested size
        // violates the window's own minimum-size hint - a slave slot
        // shorter than an app's minimum height - which can make Mutter's
        // constraint solver drop the position along with clamping the
        // size), nudge the position back without touching size.
        const settled = win.get_frame_rect();
        if (settled.x !== x || settled.y !== y) {
            win.move_frame(true, x, y);
        }

        if (actor) {
            // The WindowActor's bounds include the invisible shadow margin
            // Mutter draws around the frame, so the actor is larger than
            // the frame and its local (0,0) is the shadow's corner, not the
            // frame's - clipping to (0,0,w,h) cropped a shadow-sized sliver
            // (confirmed live: ~10px) off the right/bottom of real content.
            // Anchor the clip at the frame's actual offset within the actor
            // instead so exactly the frame area is kept, not chopped short.
            //
            // actor.x/y can keep reporting a stale pre-move position for a
            // while after move_resize_frame() has already moved the
            // underlying frame - confirmed live, computing frame.x - actor.x
            // against that stale position produced wildly wrong (even
            // negative) offsets, cropping away a large chunk of the window's
            // real content, sometimes for good since nothing else ever
            // re-touches a window that doesn't move again. This isn't only
            // a brand-new-window thing, tried gating it on that first
            // (skipping straight to a single idle tick for anything already
            // tracked once before) - confirmed live that's not reliable
            // either: opening several windows in a burst re-applies every
            // *existing* sibling too as each new one joins the same
            // manager, and that re-application can race the same
            // still-settling actor position. _applyClipWhenSettled's poll
            // starts checking immediately (no artificial delay before its
            // first attempt), so an already-correct actor costs nothing
            // extra - only a genuinely still-settling one waits.
            //
            // The poll is async and can span several of these calls landing
            // for the same window in a burst - the generation counter lets
            // a superseded (older) poll recognize that and skip itself
            // instead of clobbering a newer, correct write afterwards.
            // A small position-only nudge (frame moves a handful of px,
            // size unchanged - the common case for a tray-restored window
            // that reopens already at very nearly its tiled slot) can leave
            // the actor's pre-move x/y in place long enough that the offset
            // it produces still looks like a plausible shadow margin by
            // coincidence, and sizeSane can't catch it since the size never
            // changed - confirmed live (KeePassXC and Kortalk, tray
            // restore): frame.y moved 32->42 while actor.y stayed stuck at
            // its old value, producing off=18 instead of the real ~8, which
            // passed the ±40 sanity check on the very first poll and locked
            // in a clip that cropped ~10px off the top of the window. Pass
            // the exact pre-move actor position through so the poll can
            // require it to have actually changed (on whichever axis the
            // move actually targeted) before trusting anything else -
            // narrower than widening the threshold, which would just make
            // a bigger stale nudge slip through the same way.
            const staleX = beforeFrame.x !== x ? beforeX : null;
            const staleY = beforeFrame.y !== y ? beforeY : null;
            const generation = (this._clipGeneration.get(win) || 0) + 1;
            this._clipGeneration.set(win, generation);
            this._applyClipWhenSettled(win, w, h, 0, generation, staleX, staleY);
        }

        // Cinnamon's own move/resize animation only fires for muffin's
        // internal maximize/unmaximize/tile transitions, not for plain
        // move_resize_frame() calls from an extension - fake a slide by
        // offsetting the actor back to its old position via translation
        // and easing that offset back to zero. Only ever remove *this*
        // animation's own translation transitions, never
        // remove_all_transitions() - a freshly-mapped window is very
        // possibly mid-fade-in (Cinnamon's own map effect eases opacity
        // and scale on the same actor for ~a couple hundred ms after it
        // first appears), and wiping every transition cancelled that one
        // before it reached full opacity, with nothing left to ever finish
        // it - confirmed live this is what left newly-opened windows (an
        // image/video viewer, first tiled immediately after mapping)
        // stuck partially transparent until some other, unrelated actor
        // change happened to touch opacity back to normal.
        if (animate && actor && beforeX !== null && (beforeX !== actor.x || beforeY !== actor.y)) {
            actor.remove_transition("translation-x");
            actor.remove_transition("translation-y");
            actor.translation_x = beforeX - actor.x;
            actor.translation_y = beforeY - actor.y;
            actor.ease({
                translation_x: 0,
                translation_y: 0,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        const applied = win.get_frame_rect();
        this._lastAppliedRect.set(win, { x: applied.x, y: applied.y, w: applied.width, h: applied.height });
    }

    // See _applyOne - polls (25ms, up to 2s) until frame.x - actor.x /
    // frame.y - actor.y looks like a real shadow margin (well under 40px)
    // rather than a stale pre-tile actor position, then sets the clip.
    // Confirmed live that with several windows mapping in rapid succession
    // (contending for the compositor), that lag can run well past the
    // original 500ms budget this used - giving up and applying whatever
    // insane offset was last seen produced an even worse crop than not
    // clipping at all, so past the cap this now leaves the window
    // unclipped instead of guessing: momentarily losing the "can't spill
    // into a neighboring tile" protection on a brand new window is far
    // less bad than actively cropping its real content on a wrong offset,
    // and the very next geometry settle (or drag, or enforcement tick)
    // will apply a correct clip once the actor position is sane anyway.
    // Bails out early if a newer _applyOne call for this same window has
    // already superseded this one (see the generation counter in
    // _applyOne).
    //
    // The offset alone isn't enough to tell "settled" from "stale" apart -
    // confirmed live on a brand-new window: at the very first poll tick the
    // actor was still at its pre-tile size (e.g. a terminal's default
    // 1240x670) while get_frame_rect() already reported the *new*, much
    // larger tiled frame. That mismatch happened to produce a small offset
    // purely by coincidence (the old spawn position and the new tile
    // position were only ~30px apart this time), so it passed the ±40
    // check and got locked in as the permanent clip - sized for the new
    // frame but positioned for the old actor, cropping a real chunk of the
    // window (confirmed live: the top edge) until some unrelated later
    // event happened to touch its geometry again. Requiring the actor's
    // *size* to already be within a shadow-margin's width of the target
    // size closes that gap: a still-old-sized actor now keeps polling
    // instead of being accepted as settled.
    //
    // Neither offsetSane nor sizeSane catches a *position-only* nudge by a
    // few px with the size unchanged - the common shape of a tray-restored
    // window reopening already very close to its tiled slot - confirmed
    // live (KeePassXC, Kortalk): frame.y moved 32->42 while the actor's y
    // stayed stuck at its old value for at least one poll tick, producing
    // an offset (18) that was simply wrong rather than absent, so it still
    // read as a plausible shadow margin and sizeSane passed trivially since
    // the size genuinely never changed. Locked in a clip cropping ~10px off
    // the top of the window. staleX/staleY (the actor's exact pre-move
    // coordinate, only set by _applyOne on whichever axis actually moved)
    // close that gap: an actor still sitting at exactly its pre-move spot
    // on an axis that was supposed to move can't be trusted yet regardless
    // of what the arithmetic says, so it keeps polling until the actor
    // itself shows the move actually landed.
    //
    // Still not the whole gap though - confirmed live this can still crop
    // a tray-restored window's top edge even with the above in place:
    // staleX/staleY only rules out an actor *frozen* at its exact pre-move
    // spot, not one *gradually* easing toward the real target through a
    // sequence of distinct intermediate positions (Cinnamon's own map/show
    // effects can animate the actor in on their own, separately from
    // _applyOne's own translation-based slide below) - any one of those
    // in-between values that happens to land within the ±40px shadow-margin
    // window (easily does, this close to the end of a short animation)
    // looks exactly as "sane" as the real final one and was getting
    // accepted on the spot. lastSeen requires the *same* reading twice in a
    // row (25ms apart) before trusting it - actually settled, not just
    // "moved away from where it started" - which staleX/staleY alone can't
    // tell apart from "still mid-transition".
    _applyClipWhenSettled(win, w, h, attempt, generation, staleX = null, staleY = null, lastSeen = null) {
        if (this._clipGeneration.get(win) !== generation) return;
        const a = win.get_compositor_private();
        if (!a) return;
        const stillStale = (staleX !== null && a.x === staleX) || (staleY !== null && a.y === staleY);
        const fr = win.get_frame_rect();
        const offX = fr.x - a.x;
        const offY = fr.y - a.y;
        const SHADOW_MARGIN_MAX = 40;
        const offsetSane = Math.abs(offX) <= SHADOW_MARGIN_MAX && Math.abs(offY) <= SHADOW_MARGIN_MAX;
        const sizeSane =
            a.width >= w &&
            a.width <= w + SHADOW_MARGIN_MAX * 2 &&
            a.height >= h &&
            a.height <= h + SHADOW_MARGIN_MAX * 2;
        const stable = !!lastSeen && lastSeen.x === a.x && lastSeen.y === a.y && lastSeen.width === a.width && lastSeen.height === a.height;
        if (!stillStale && stable && offsetSane && sizeSane) {
            a.set_clip(offX, offY, w, h);
            return;
        }
        if (attempt >= 80) {
            global.logWarning(`[${this.uuid}] ${win.get_wm_class()} never settled a sane actor offset - leaving it unclipped`);
            // "Unclipped" has to mean it, not just "don't set a new one" -
            // a window that already had a clip from an earlier, successful
            // settle (e.g. tab-strip reservation toggling its slot's height)
            // would otherwise keep that now-stale clip forever, since
            // nothing else ever revisits it once its frame rect stops
            // changing (maximized layout in particular - every window
            // shares one static full-area rect, so a window that isn't
            // currently topmost can sit fully mapped but uncomposited long
            // enough for this poll to give up before its actor ever catches
            // up, and then keeps showing whatever crop was correct for
            // its *previous* target rect once it's raised back to front).
            if (a.has_clip) a.remove_clip();
            return;
        }
        const seen = { x: a.x, y: a.y, width: a.width, height: a.height };
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25, () => {
            this._applyClipWhenSettled(win, w, h, attempt + 1, generation, staleX, staleY, seen);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Backstop for windows that asynchronously revert their own geometry
    // after being tiled (see _commitGeometryChange). The debounced
    // size-changed/position-changed handler above already re-corrects a
    // window every time it drifts - confirmed live (with tiling fully
    // disabled) that apps like TelegramDesktop/sshpilot/Mailspring revert
    // exactly once per external touch and then hold still, so that
    // event-driven loop alone is enough to keep pulling them back forever.
    // This timer exists only for the case a future misbehaving app somehow
    // changes its own geometry without ever firing those signals, so it
    // ticks slowly and just double-checks - it deliberately does NOT run
    // fast enough to meaningfully add to the correction cadence above (a
    // second independent corrector racing the first would only add more
    // uncoordinated resize calls for the app to react to, worse not
    // better). _applyOne's clip is what actually keeps the grid visually
    // bounded moment to moment; this timer is only about eventual
    // consistency. Idempotent - calling this again for a window that's
    // already being watched is a no-op. Stops itself once the window holds
    // still for a few consecutive ticks, and _commitGeometryChange restarts
    // it if the window drifts again later.
    _startEnforcing(win) {
        if (this._enforceTimers.has(win)) return;
        let settledTicks = 0;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            if (!this.tilingEnabled) {
                this._enforceTimers.delete(win);
                return GLib.SOURCE_REMOVE;
            }
            const mg = this._managerFor(win);
            if (!mg) {
                this._enforceTimers.delete(win);
                return GLib.SOURCE_REMOVE;
            }

            // A held mouse button means the user is genuinely interacting
            // with something right now - never fight a live drag/resize.
            if (this._pointerButtonHeld()) return GLib.SOURCE_CONTINUE;

            const wa = this._workAreaRect(mg);
            const rects = wa ? mg.compute(wa, this.gapSize || 0, (w) => this._windowGroupKey(w)) : null;
            if (rects) this._reserveWindowTabSpace(mg, rects);
            const target = rects ? rects.get(win) : null;
            if (!target) return GLib.SOURCE_CONTINUE;

            const cur = win.get_frame_rect();
            const onTarget =
                cur.x === Math.round(target.x) &&
                cur.y === Math.round(target.y) &&
                cur.width === Math.max(1, Math.round(target.w)) &&
                cur.height === Math.max(1, Math.round(target.h));

            if (onTarget) {
                settledTicks++;
                if (settledTicks >= 3) {
                    this._enforceTimers.delete(win);
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            }

            settledTicks = 0;
            this._applyOne(win, target, false);
            return GLib.SOURCE_CONTINUE;
        });
        this._enforceTimers.set(win, id);
    }

    _stopEnforcing(win) {
        const id = this._enforceTimers.get(win);
        if (id) {
            GLib.source_remove(id);
            this._enforceTimers.delete(win);
        }
    }

    // Finds the tracked window (other than excludeWin) whose current geometry
    // contains point, used to swap grid slots on a manual drag-drop. Several
    // windows can share the exact same slot (round-robin, cycled via focus -
    // see README), so more than one candidate can fully overlap the same
    // point. mg.allWindows()'s iteration order has no relation to visual
    // stacking - confirmed live: dropping onto a slot with a few windows
    // stacked in it could swap with whichever one happened to be earliest in
    // that order rather than the one actually visible on top, silently
    // landing the dragged window behind a window the user could see and was
    // aiming at. Sorting the candidates by real stacking order and taking
    // the topmost matches what the user is actually looking at.
    _windowAtPoint(mg, point, excludeWin) {
        const candidates = [];
        for (const w of mg.allWindows()) {
            if (w === excludeWin) continue;
            const r = w.get_frame_rect();
            if (point.x >= r.x && point.x < r.x + r.width && point.y >= r.y && point.y < r.y + r.height) {
                candidates.push(w);
            }
        }
        if (candidates.length <= 1) return candidates[0] || null;
        const sorted = global.display.sort_windows_by_stacking(candidates);
        return sorted[sorted.length - 1];
    }

    _tileAll() {
        for (const mg of this._managers.values()) this._retile(mg);
    }

    // Restores every window in mg to its pre-tiling geometry and stops
    // tiling them - previously only repositioned them, leaving them fully
    // tracked, so the very next unrelated retile (opening/closing another
    // window, a workspace switch, ...) silently snapped them right back
    // into the tile with no visible cause. Toggling tiling off then on
    // again re-tracks and re-tiles every open window (_trackExisting()),
    // so that's the way back in if a restored window is wanted back.
    _restoreManager(mg) {
        for (const win of Array.from(mg.allWindows())) {
            const orig = this._originalGeometry.get(win);
            this._untrackWindow(win, mg);
            if (orig) win.move_resize_frame(true, orig.x, orig.y, orig.w, orig.h);
        }
        // _untrackWindow deliberately never retiles mg itself (see its own
        // comment) - every other caller does that right after, but this
        // loop didn't, which orphaned this manager's window-tab-strip
        // actors: still St.BoxLayout/St.Button widgets with reactive: true,
        // sitting in Main.uiGroup at wherever their last position was,
        // never destroyed. Confirmed live this is exactly what "Restore"
        // used to leave behind - an invisible-looking strip silently
        // eating clicks in its old screen area, then visibly reappearing
        // (it was never actually gone) the instant some *other* window's
        // tile happened to land under it, looking like a decorated,
        // no-longer-tiled app had somehow grown tabs of its own. mg is
        // empty at this point, so _retile() computes zero rects/groups and,
        // via _syncWindowTabStrips(mg, []), destroys every leftover strip
        // that belonged to it - the same cleanup _toggleFloating and
        // _onIgnoreListChanged already get for free by retiling right
        // after they untrack.
        this._retile(mg);
    }

    // Undoes the slot-bounding clip _applyOne sets, so a window that's no
    // longer tiled (restored, ignored, or the whole applet disabled) isn't
    // left visually cropped to the size of its last tile slot.
    _clearClip(win) {
        const actor = win.get_compositor_private();
        if (actor && actor.has_clip) actor.remove_clip();
    }

    // ---- global signal handlers ----

    _connectGlobalSignals() {
        const connect = (obj, sig, cb) => this._globalSignals.push([obj, obj.connect(sig, cb.bind(this))]);
        connect(global.display, "window-created", this._onWindowCreated);
        connect(global.display, "notify::focus-window", this._onFocusWindowChanged);
        connect(global.workspace_manager, "workspace-switched", this._onWorkspaceSwitched);
        connect(global.workspace_manager, "workspace-added", this._onWorkspaceListChanged);
        connect(global.workspace_manager, "workspace-removed", this._onWorkspaceListChanged);
        connect(global.workspace_manager, "workspaces-reordered", this._onWorkspaceListChanged);
        connect(Main.layoutManager, "monitors-changed", this._onMonitorsChanged);
        // Adding/removing a panel (or a dock reserving its own strut)
        // changes each monitor's *work area* without changing the
        // monitors themselves, so it doesn't fire monitors-changed at all
        // - confirmed live a tiled window kept its old, now-undersized (or
        // oversized) rect after removing a panel, until something else
        // happened to retile it (nudging the window a bit triggers
        // _onWindowGeometryChanged, which is what made it look like
        // moving it "fixed" the size). _workAreaRect() re-reads the work
        // area fresh on every retile, so just re-triggering one here is
        // enough - no different from monitors-changed's own handler.
        connect(global.display, "workareas-changed", this._onMonitorsChanged);
        // Window tab strips are chrome living inside global.window_group
        // (addToWindowgroup, see _syncWindowTabStrips) - the overview's own
        // background/covering pane sits above window_group entirely, same
        // as it does for _focusBorder (plain Main.uiGroup.add_actor), so
        // both still need this explicit hide/show pair despite living at
        // different points in the tree. Expo and the window overview each
        // have their own showing/hidden pair (same emit() convention,
        // confirmed in both overview.js and expo.js) rather than sharing one.
        connect(Main.overview, "showing", this._hideAllWindowTabStripsForOverview);
        connect(Main.overview, "hidden", this._updateWindowTabVisibility);
        connect(Main.expo, "showing", this._hideAllWindowTabStripsForOverview);
        connect(Main.expo, "hidden", this._updateWindowTabVisibility);
        // 'restacked' is what keeps a strip's own position among real
        // window actors current (see _restackWindowTabStrip) - fires for
        // any stacking change anywhere, including ones kortile has no
        // signal hookup of its own for (switching tabs raises one of the
        // group's own windows above its neighbors; a window kortile never
        // tracks at all, like Guake's own drop-down terminal, can be raised
        // over a strip with no per-window hookup here to catch it either) -
        // broad and window-agnostic instead of needing to know in advance
        // which window might someday need watching.
        connect(global.display, "restacked", this._onWindowsRestacked);
    }

    _restackAllWindowTabStrips() {
        for (const entry of this._windowTabGroups.values()) this._restackWindowTabStrip(entry);
    }

    // 'restacked' fires the instant a hide/show is *requested*, not once
    // it's actually finished - confirmed live with Guake's own drop-down
    // slide animation still mid-flight when this first runs. The immediate
    // pass below already reads real stacking order, which updates
    // synchronously with the request, so it gets the right answer straight
    // away for that case - the follow-up 300ms recheck (same delay
    // _onWorkspaceSwitched gives Cinnamon's own window-effect transitions
    // elsewhere here) is a defensive catch-all for anything that settles
    // asynchronously instead, so a strip never gets stuck anchored to a
    // window actor that's since gone away mid-animation.
    _onWindowsRestacked() {
        this._restackAllWindowTabStrips();
        if (this._windowTabRestackRecheckId) GLib.source_remove(this._windowTabRestackRecheckId);
        this._windowTabRestackRecheckId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._windowTabRestackRecheckId = null;
            this._restackAllWindowTabStrips();
            return GLib.SOURCE_REMOVE;
        });
    }

    _hideAllWindowTabStripsForOverview() {
        for (const entry of this._windowTabGroups.values()) entry.actor.hide();
    }

    _disconnectGlobalSignals() {
        for (const [obj, id] of this._globalSignals) obj.disconnect(id);
        this._globalSignals = [];
    }

    // ---- focus border ----

    // Outlines whichever window currently has focus with a bright border -
    // several of the apps this tiles are CSD with little or no Mutter-drawn
    // border of their own (confirmed via _NET_FRAME_EXTENTS, see README),
    // so with tiled windows edge-to-edge there's often nothing else showing
    // which one has focus. Not limited to tiled windows - a floating/dialog
    // window gets the same outline while focused, since Cinnamon doesn't
    // reliably show that either depending on theme/window decoration.
    _onFocusWindowChanged() {
        this._updateFocusBorder();
        if (this.windowTabsEnabled) {
            // Which app's strip should show for a shared slot depends on
            // which window is topmost there right now (see
            // _reserveWindowTabSpace) - focusing/raising a different one
            // sharing that same slot can change that with no geometry
            // change of its own for anything else here to react to, so a
            // retile (which recomputes that) is what keeps the *right*
            // strip showing, not just which button within it is lit up.
            const win = global.display.focus_window;
            const mg = win && this._managerFor(win);
            if (mg && !this._isCoveredByMaximizedWindow(win)) {
                // Whatever brought focus here - a taskbar click, Alt+Tab,
                // anything other than kortile's own tab strip - may only
                // have set *keyboard* focus without actually raising the
                // window: activate() alone doesn't reliably do that in
                // this environment (see _activateAndRaise). Confirmed
                // live: clicking a taskbar icon for an app sharing a slot
                // with other windows moved focus there, but the *previous*
                // tab (whichever one was last explicitly raised) stayed
                // visually on top - the strip below kept showing the old
                // tab active while keyboard input actually went to the
                // one behind it. Raising here too, not just from
                // kortile's own tab-click handler, keeps whichever window
                // actually has focus the one actually visible, regardless
                // of how it got focused.
                win.raise();
                this._retile(mg);
            }
        }
        this._updateWindowTabHighlights();
    }

    // A tiled window's own manager can still be sharing a monitor/workspace
    // with a *different* window that's maximized or fullscreen - it's
    // removed from mg the moment it maximizes (see
    // _onWindowMaximizedChanged/_onWindowFullscreenChanged), and mg retiles
    // whatever's left to fill the space it vacated, but nothing stops that
    // freed-up space from now covering the same screen area the maximized
    // window occupies. Confirmed live: with focus-follows-mouse on,
    // hovering that shared area focused the tiled window sitting
    // underneath, and the unconditional win.raise() above then put it
    // right on top of the still-maximized one - visually indistinguishable
    // from the maximize having been silently undone, even though the
    // maximized window's own state never actually changed. Whatever
    // legitimately holds that state stays visually on top until the user
    // deliberately switches away from it, not just because focus briefly
    // blipped onto whatever's tiled underneath it.
    _isCoveredByMaximizedWindow(win) {
        const monIndex = win.get_monitor();
        const ws = win.get_workspace();
        for (const actor of global.get_window_actors()) {
            const other = actor.get_meta_window();
            if (!other || other === win || other.minimized) continue;
            if (!other.is_fullscreen() && other.get_maximized() === 0) continue;
            if (other.get_monitor() !== monIndex) continue;
            const otherWs = other.get_workspace();
            if (ws && otherWs && otherWs.index() !== ws.index() && !other.is_on_all_workspaces()) continue;
            return true;
        }
        return false;
    }

    // Alt + left-drag move / Alt + right-drag resize (from whichever corner
    // is nearest the cursor) is a built-in Muffin feature, off by default -
    // this doesn't reimplement it, it just flips the two system prefs that
    // turn it on (Settings → Windows → same modifier key setting). A
    // from-scratch version of this via Cinnamon's own event handling turned
    // out to be a dead end: captured-event at the stage level never sees
    // input destined for real window content unless a full modal grab is
    // active (confirmed live), and a permanent modal grab would swallow all
    // other input - not viable for an always-on toggle.
    _onAltDragMoveResizeSettingChanged() {
        this._applyAltDragMoveResizeSetting();
    }

    _applyAltDragMoveResizeSetting() {
        if (this.altDragMoveResizeEnabled) {
            this._wmPrefs.set_string("mouse-button-modifier", "<Alt>");
            this._wmPrefs.set_boolean("resize-with-right-button", true);
        } else {
            this._wmPrefs.set_string("mouse-button-modifier", "");
        }
    }

    // "Focus follows mouse" and "auto-raise" are both Cinnamon/Muffin's own
    // built-in WM prefs (Settings → Windows), not something this applet
    // implements - same idea as the Alt-drag toggle above, these just flip
    // the underlying system settings on/off instead of reimplementing them.
    // Two separate toggles rather than one, deliberately - focus-mode alone
    // only *focuses* whatever's under the pointer, it doesn't raise it
    // (confirmed live: with auto-raise off, hovering a partially-covered
    // window focused it without visibly bringing it forward at all, which
    // looks exactly like hovering did nothing), and Cinnamon itself treats
    // that as two independent choices (its own Windows settings shows the
    // "raise" checkbox as a separate control under the focus-mode
    // dropdown, not bundled into one switch) - someone might genuinely
    // want hover-to-focus without windows jumping to the front on every
    // pointer pass, so this doesn't force the pairing either.
    // auto-raise-delay (its own control just below) only actually matters
    // while the raise toggle is on (auto-raise only ever fires for a focus
    // change that happened *without* a click, i.e. hover focus - Cinnamon
    // doesn't enforce that dependency itself, turning the delay up with
    // raise off just does nothing), but is still applied unconditionally
    // here regardless of either toggle, same as Cinnamon's own Windows
    // settings panel does it.
    _onFocusFollowsMouseSettingChanged() {
        this._applyFocusFollowsMouseSetting();
    }

    _applyFocusFollowsMouseSetting() {
        this._wmPrefs.set_string("focus-mode", this.focusFollowsMouseEnabled ? "mouse" : "click");
        this._wmPrefs.set_boolean("auto-raise", this.focusFollowsMouseRaiseEnabled);
        this._wmPrefs.set_int("auto-raise-delay", this.focusFollowsMouseRaiseDelay);
    }

    // Shared by both the on/off toggle and the icons-vs-titles style
    // combobox - either one needs a full teardown, not just a retile.
    // Toggling off: an already-applied reservation (window shrunk/shifted
    // down to make room for a strip) only ever gets undone by *another*
    // retile actually recomputing that window's rect, and every existing
    // strip widget needs to go, not just stop growing - destroying them
    // all up front means they're gone immediately rather than
    // _syncWindowTabStrips cleaning them up gradually, one manager at a
    // time as each happens to retile next. Style change: _syncWindowTabStrips
    // only ever *adds* buttons for windows newly joining a still-existing
    // group, it has no reason to rebuild ones already there - without
    // destroying everything first, an existing strip would keep showing
    // buttons built the old way until its group's membership actually
    // changed for some unrelated reason.
    _onWindowTabsSettingChanged() {
        this._destroyAllWindowTabStrips();
        this._tileAll();
    }

    _onFocusBorderSettingChanged() {
        this._updateFocusBorder();
    }

    // Color/width changed - re-style the (possibly already visible) border
    // in place, then let _updateFocusBorder fix up its geometry for the
    // new width.
    _onFocusBorderStyleSettingChanged() {
        this._applyFocusBorderStyle();
        this._updateFocusBorder();
    }

    _applyFocusBorderStyle() {
        const color = this.focusBorderColor || FOCUS_BORDER_COLOR_DEFAULT;
        const width = Math.max(1, this.focusBorderWidth || FOCUS_BORDER_WIDTH_DEFAULT);
        this._focusBorder.style = `border: ${width}px solid ${color}; border-radius: 2px;`;
    }

    _updateFocusBorder() {
        // Tiling off (menu/keybinding/Settings) already untracks every
        // window and hides the border once, via _untrackAll -
        // _hideFocusBorder() - but nothing here stopped it coming right
        // back: this function has no idea tiling is off, so the very next
        // focus change (clicking any window at all) ran straight through
        // to showing it again, on a window kortile isn't even touching
        // anymore. The border's own purpose (telling tiled windows apart,
        // several of which have no WM-drawn border of their own) doesn't
        // apply to anything once tiling itself is off.
        if (!this.tilingEnabled || !this.focusBorderEnabled) {
            this._hideFocusBorder();
            return;
        }

        const win = global.display.focus_window;
        // A fullscreen window's frame *is* the screen, so a border around
        // it would just outline the screen edge - never useful.
        if (!win || win.minimized || win.is_fullscreen()) {
            this._hideFocusBorder();
            return;
        }
        if (!FOCUS_BORDER_WINDOW_TYPES.includes(win.get_window_type())) {
            this._hideFocusBorder();
            return;
        }
        // A brand-new window, not tracked yet (see _onWindowCreated) -
        // showing the border now and possibly hiding it again a moment
        // later once tracking resolves is a real, visible flash, not just
        // a stale-until-corrected state. Wait for that to resolve either
        // way instead of guessing.
        if (this._pendingTrack.has(win)) {
            global.log(`[kortile-debug] _updateFocusBorder: still pending, hiding border for "${win.get_wm_class() || "?"}"`);
            this._hideFocusBorder();
            return;
        }

        const activeWs = global.workspace_manager.get_active_workspace_index();
        const onActiveWorkspace = win.get_workspace() && win.get_workspace().index() === activeWs;
        if (!onActiveWorkspace) {
            this._hideFocusBorder();
            return;
        }

        // Same idea as fullscreen: in maximized layout every window fills
        // the whole work area, so its border is likewise just a screen-edge
        // outline - true of any window there, master or slave (that split
        // is arbitrary in maximized layout, just whichever order windows
        // were opened in, and carries no visual meaning), so this is
        // optionally skipped for all of them, not just the master.
        const mg = this._managerFor(win);
        if (mg && mg.layout === "maximized" && this.focusBorderHideMaximized) {
            this._hideFocusBorder();
            return;
        }

        if (win !== this._focusBorderWin) {
            this._disconnectFocusBorderWindow();
            this._focusBorderWin = win;
            // Keep the outline glued to this window between focus changes -
            // it can move/resize (drag, retile, workspace follow) without
            // ever losing and regaining focus in between.
            this._focusBorderSignalIds = [
                win.connect("position-changed", () => this._updateFocusBorder()),
                win.connect("size-changed", () => this._updateFocusBorder()),
                win.connect("unmanaged", () => this._hideFocusBorder()),
            ];
        }

        const r = win.get_frame_rect();
        const bw = Math.max(1, this.focusBorderWidth || FOCUS_BORDER_WIDTH_DEFAULT);
        // A tab strip reserves its own space directly above (or, with
        // windowTabsSide "bottom", below) any window sharing that slot
        // (see _reserveWindowTabSpace) - the usual bw-px outward outset on
        // every side assumes an actual empty tile gap there to grow into,
        // which doesn't exist on whichever side the strip occupies:
        // confirmed live the border's own edge extended straight into the
        // strip's reserved area instead, visibly overlapping it (worse the
        // wider the configured border width). Skip the outset specifically
        // on that one side for a window currently covered by a strip -
        // the other three still border a normal tile gap, unaffected.
        let topExtend = bw;
        let bottomExtend = bw;
        for (const entry of this._windowTabGroups.values()) {
            if (entry.buttons.has(win)) {
                if (this.windowTabsSide === "bottom") bottomExtend = 0;
                else topExtend = 0;
                break;
            }
        }
        this._focusBorder.set_position(r.x - bw, r.y - topExtend);
        this._focusBorder.set_size(r.width + 2 * bw, r.height + topExtend + bottomExtend);
        this._focusBorder.show();
    }

    _disconnectFocusBorderWindow() {
        if (this._focusBorderWin) {
            for (const id of this._focusBorderSignalIds) {
                try {
                    this._focusBorderWin.disconnect(id);
                } catch (e) {
                    // window is already gone
                }
            }
        }
        this._focusBorderSignalIds = [];
        this._focusBorderWin = null;
    }

    _hideFocusBorder() {
        this._disconnectFocusBorderWindow();
        this._focusBorder.hide();
    }

    _onWindowCreated(display, metaWindow) {
        if (!this.tilingEnabled) return;
        const _dbgT0 = GLib.get_monotonic_time();
        const _dbgName = `${metaWindow.get_wm_class() || "?"}/${metaWindow.get_title() || "?"}`;
        global.log(`[kortile-debug] created "${_dbgName}" hasActorNow=${!!metaWindow.get_compositor_private()}`);

        // A brand-new window very often already holds focus before this
        // even starts, and tracking is deliberately deferred below (needs
        // first-frame/a fallback timeout) - _updateFocusBorder can and does
        // run against it in that gap, before _trackWindow has had any
        // chance to place it. Confirmed live: it fell through to the
        // untracked/floating case and showed the border for the ~30-40ms
        // until track() below runs, then correctly hid it again - a real,
        // visible flash, not just a lingering wrong state (that part's
        // covered by the explicit _updateFocusBorder() call in track()
        // below). _pendingTrack marks it as "don't show a border for this
        // one yet, tracking hasn't had its say" for exactly that window,
        // cleared right before track() makes the real decision.
        this._pendingTrack.add(metaWindow);
        if (global.display.focus_window === metaWindow) this._updateFocusBorder();

        // Applied here, synchronously, rather than waiting for track()
        // below the way the tiling decision itself has to - confirmed live
        // that waiting (even the ~30-50ms first-frame/fallback gap) is
        // long enough to paint the window at its own natural size first,
        // then visibly snap to the remembered one a moment later. Window
        // type/skip-taskbar/transient-for are already set by the time this
        // fires for the overwhelming majority of apps (unlike the
        // brief-transient-parent case _isTileable's own low-frequency
        // sweep exists for), so there's nothing to gain by waiting here
        // the way there is for the actual tiling decision. Harmless for a
        // window that ends up tiled instead - _trackWindow's own retile
        // moments later overwrites this before the first paint either way,
        // same as it would have regardless of whether this ran early or
        // late. track()'s own later call is left in place as a safety net
        // for the rare case this early one guessed wrong.
        if (this._shouldRememberFloatingSize(metaWindow)) this._applyRememberedFloatingSize(metaWindow);

        const track = () => {
            // The window can die (fully unmanaged) before this ever runs -
            // confirmed live with Mailspring's notification handling: the
            // window is created, tracked into a manager, then unmanaged
            // again within ~10-20ms (own internal hide/remap cycle as part
            // of showing the notification, not a real close - workspace
            // reads null right before the unmanage, same transient state
            // any window's teardown briefly passes through). If *this*
            // deferred callback's own first-frame signal or 50ms fallback
            // timer happens to fire after _onWindowUnmanaged has already
            // run its cleanup (which deletes this same _pendingTrack entry,
            // among other things - see there), running _trackWindow on an
            // already-dead window is nothing but harm: nothing left to
            // track, and every read on a torn-down MetaWindow past this
            // point is on borrowed time. _onWindowUnmanaged having already
            // cleared this entry is exactly the signal that happened -
            // bail out instead of guessing whether whatever's left of the
            // window can still be safely touched.
            if (!this._pendingTrack.has(metaWindow)) return;
            global.log(`[kortile-debug] track() firing for "${_dbgName}" +${(GLib.get_monotonic_time() - _dbgT0) / 1000}ms`);
            this._pendingTrack.delete(metaWindow);
            this._applyWorkspaceRule(metaWindow);
            this._trackWindow(metaWindow, true, true);
            // Connected unconditionally, whether or not this window ends up
            // tiled - _shouldRememberFloatingSize is what keeps this a
            // no-op while tiled, so a window later toggled floating
            // (kb-toggle-floating) starts being remembered from its very
            // next resize without needing its own separate hookup there.
            metaWindow.connect("size-changed", () => this._onFloatingWindowSizeChanged(metaWindow));
            if (this._shouldRememberFloatingSize(metaWindow)) this._applyRememberedFloatingSize(metaWindow);
            // Re-checks even for a window that stays untracked (ignored,
            // not tileable, ...) - it should get the border like any other
            // floating window now that _pendingTrack no longer holds it
            // back, not stay suppressed forever. Also still needed for the
            // tracked case: the initial retile's move_resize_frame() only
            // fires a position/size-changed (which the border's own
            // per-window listeners react to) if it actually produces a
            // delta - confirmed live it doesn't when the window's own
            // initial geometry already happens to match its tile target
            // (not unusual in maximized layout, where every window gets
            // the exact same full-area rect), which would otherwise leave
            // the border stuck showing with nothing left to correct it.
            this._updateFocusBorder();
            global.log(
                `[kortile-debug] track() done for "${_dbgName}" +${(GLib.get_monotonic_time() - _dbgT0) / 1000}ms borderVisible=${this._focusBorder.visible}`
            );
        };
        const actor = metaWindow.get_compositor_private();
        if (actor) {
            const id = actor.connect("first-frame", () => {
                global.log(`[kortile-debug] first-frame for "${_dbgName}" +${(GLib.get_monotonic_time() - _dbgT0) / 1000}ms`);
                actor.disconnect(id);
                track();
            });
        } else {
            global.log(`[kortile-debug] no actor yet for "${_dbgName}", falling back to 50ms timer`);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                global.log(`[kortile-debug] 50ms fallback firing for "${_dbgName}" +${(GLib.get_monotonic_time() - _dbgT0) / 1000}ms`);
                track();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _onWindowUnmanaged(win) {
        const mg = this._managerFor(win);
        // A minimized window has already been removed from its manager
        // (_managerFor(win) above is null for it) but can still be
        // showing a tab for it, kept alive by _minimizedWindowManager
        // (see _onWindowMinimizedChanged/_reserveWindowTabSpace) - closing
        // it from there (its taskbar entry, say, never un-minimizing it
        // first) needs that same manager retiled too, or its now-dead tab
        // would linger in the strip until something unrelated happened to
        // retile that manager next.
        const minimizedMg = this._minimizedWindowManager.get(win);
        this._detachWindowSignals(win);
        this._originalGeometry.delete(win);
        this._lastAppliedRect.delete(win);
        this._lastRequestedRect.delete(win);
        this._stubbornCount.delete(win);
        this._dragFlag.delete(win);
        this._clipGeneration.delete(win);
        this._floatingWindows.delete(win);
        this._nativeMaximizedWindows.delete(win);
        this._removedWindowPosition.delete(win);
        this._windowTabCustomNames.delete(win);
        this._minimizedWindowManager.delete(win);
        this._pendingTrack.delete(win);
        this._cancelGeometryDebounce(win);
        this._stopEnforcing(win);
        this._cancelDragReleasePoll(win);
        if (mg) {
            mg.removeWindow(win);
            this._retile(mg);
        } else if (minimizedMg) {
            this._retile(minimizedMg);
        }
    }

    // "Send to workspace N" (menu/keybinding) changes desktop without moving
    // the window at all, so it fires no position-changed for the debounced
    // path below to catch - handle it directly instead.
    _onWindowWorkspaceChanged(win) {
        if (!this.tilingEnabled) return;
        const mg = this._managerFor(win);
        if (!mg) return;
        // See _isWorkspaceIndependentMonitor - on a secondary monitor under
        // "Workspaces only on primary display", get_workspace() mirrors
        // whatever workspace is active on the *primary* monitor, so this
        // fires constantly with no real move involved; reassigning on it
        // would fragment that monitor's windows across a fresh manager
        // every time the primary switches workspace.
        if (this._isWorkspaceIndependentMonitor(mg.monitorIndex)) return;

        const newWs = win.get_workspace();
        if (!newWs || newWs.index() === mg.workspaceIndex) return;

        mg.removeWindow(win);
        this._retile(mg);

        const target = this._getOrCreateManager(newWs.index(), mg.monitorIndex);
        target.addWindow(win);
        this._retile(target);
    }

    // Cinnamon renumbers every workspace after the point of an add/remove/
    // reorder (workspace-added/-removed/workspaces-reordered) - that's a
    // change to a workspace's *position* in the list, not a window actually
    // moving to a different Meta.Workspace object, so a window's own
    // "workspace-changed" signal (see _onWindowWorkspaceChanged just above)
    // never fires for it. Confirmed live: removing/reordering workspaces
    // elsewhere left a manager's key (wsIndex:monIndex) silently stale -
    // its windows kept whatever geometry that manager had last applied
    // (frozen there, since nothing ever retiles a window whose manager
    // doesn't match its real current workspace anymore - looked exactly
    // like a leftover vertical-left split that never went away), while the
    // *actual* workspace now sitting at that index got its own fresh,
    // separate, empty manager instead (back to defaultLayout) - the
    // applet's menu, which always reflects whichever manager currently
    // owns that key, showed that fresh manager's layout with no relation
    // to what the windows were still visibly doing.
    //
    // A manager's whole window set was grouped together in the first place
    // because they shared a workspace, and nothing here moves a window to a
    // *different* workspace object (that's the other handler, just above) -
    // so if every one of a manager's windows now agrees on one single real
    // index that isn't the manager's own, that's this renumbering, not a
    // real move, and the manager itself (layout, master/slave ratios, all
    // of it) is renamed to the new key in place rather than dissolved -
    // confirmed live a first version of this that rebuilt fresh managers
    // window-by-window instead silently reset every affected manager back
    // to defaultLayout, trading the "wrong label" bug for a "your layout
    // choice just got discarded" one instead. A manager whose windows
    // disagree with each other (shouldn't normally happen) is left alone
    // rather than guessed at.
    _onWorkspaceListChanged() {
        if (!this.tilingEnabled) return;
        for (const [key, mg] of Array.from(this._managers.entries())) {
            if (this._isWorkspaceIndependentMonitor(mg.monitorIndex)) continue;
            const wins = mg.allWindows();
            if (wins.length === 0) continue;

            const indices = new Set(wins.map((w) => (w.get_workspace() ? w.get_workspace().index() : null)));
            if (indices.size !== 1) continue;
            const [newIndex] = indices;
            if (newIndex === null || newIndex === mg.workspaceIndex) continue;

            const newKey = this._managerKey(newIndex, mg.monitorIndex);
            if (newKey === key) continue;
            this._managers.delete(key);
            // _rememberedLayouts is keyed the exact same way _managers is -
            // rename it right alongside so a workspace reorder doesn't
            // leave this feature's own remembered choice attached to the
            // (now wrong) old key for the rest of the session.
            if (this._rememberedLayouts.has(key)) {
                const layout = this._rememberedLayouts.get(key);
                this._rememberedLayouts.delete(key);
                this._rememberedLayouts.set(newKey, layout);
                if (this.rememberLayoutPerWorkspace) this._saveRememberedLayouts();
            }

            const existing = this._managers.get(newKey);
            if (existing) {
                // Something's already sitting at the real target index (a
                // fresh manager auto-created by an unrelated lookup in
                // between) - merge into it rather than discarding either
                // side's windows. Not renaming _windowTabOrder/_windowTabGroups
                // here the way the plain rename below does - existing already
                // has its own valid entries at newKey, and blindly renaming
                // mg's old ones on top would clobber them instead of the
                // orphaned old entries just going unused.
                for (const w of wins) existing.addWindow(w);
                this._retile(existing);
            } else {
                mg.workspaceIndex = newIndex;
                this._managers.set(newKey, mg);
                // _windowTabOrder and _windowTabGroups are both keyed
                // "wsIndex:monIndex:<rectKey-or-all>", same wsIndex:monIndex
                // prefix _managers/_rememberedLayouts use - confirmed live a
                // saved drag-reorder (and the group's own strip actor) went
                // missing after a workspace reorder/removal renumbered this
                // manager: _orderWindowTabGroup's lookup uses mg's *new* key
                // to read _windowTabOrder, which was still only ever saved
                // under the old one, so it silently fell back to natural
                // order - and _syncWindowTabStrips' own cleanup pass (which
                // only ever matches the *current* mgPrefix) never recognized
                // the old-keyed strip entries as belonging to this manager
                // either, orphaning them on screen instead of reusing or
                // destroying them.
                this._renameManagerGroupKeys(key, newKey, newIndex);
                this._retile(mg);
            }
        }
        this._syncMenu();
    }

    // See the call site in _onWorkspaceListChanged - moves every
    // _windowTabOrder/_windowTabGroups entry whose key starts with
    // "oldKey:" over to "newKey:" instead, keeping the same rectKey-or-"all"
    // suffix. Reuses the existing strip actor/buttons in _windowTabGroups
    // rather than letting them go orphaned and rebuilt from scratch -
    // nothing about the actual layout changed here, only which manager (by
    // workspace index) owns it.
    _renameManagerGroupKeys(oldKey, newKey, newWsIndex) {
        const oldPrefix = `${oldKey}:`;
        const newPrefix = `${newKey}:`;
        let renamedAnyOrder = false;
        for (const [tabKey, order] of Array.from(this._windowTabOrder.entries())) {
            if (!tabKey.startsWith(oldPrefix)) continue;
            this._windowTabOrder.delete(tabKey);
            this._windowTabOrder.set(newPrefix + tabKey.slice(oldPrefix.length), order);
            renamedAnyOrder = true;
        }
        // Persisted order is keyed the same way (see _saveWindowTabOrder) -
        // without this, the on-disk copy would still point at the old key,
        // so a restart *after* a workspace reorder/removal would fail to
        // resolve it against this manager's new one and fall back to
        // natural order all over again.
        if (renamedAnyOrder) this._saveWindowTabOrder();
        for (const [groupKey, entry] of Array.from(this._windowTabGroups.entries())) {
            if (!groupKey.startsWith(oldPrefix)) continue;
            this._windowTabGroups.delete(groupKey);
            this._windowTabGroups.set(newPrefix + groupKey.slice(oldPrefix.length), entry);
            // entry.wsIndex is only ever set once, at creation time (see
            // _syncWindowTabStrips) - reusing the same entry object under
            // its new key without also updating this left it permanently
            // stale, comparing against a workspace index that no longer
            // matches anything real. Confirmed live: _updateWindowTabVisibility
            // checks entry.wsIndex === activeWs on every switch (including
            // the now-instant check right at the top of
            // _onWorkspaceSwitched) - a stale value there meant the strip
            // could never be judged "on the active workspace" again and
            // stayed hidden for good, on whichever workspace this manager
            // ended up renumbered to. (Never -1 here in the first place -
            // the caller already skips workspace-independent monitors
            // before ever reaching this rename.)
            entry.wsIndex = newWsIndex;
        }
    }

    _onWindowMinimizedChanged(win) {
        // A floating window minimizing/restoring falls through both
        // branches below as a harmless no-op - it's not tiling-tracked
        // either way (_isTileable already excludes it, see _trackWindow),
        // so _managerFor(win) is null in the first branch and _trackWindow
        // in the second is a no-op for it - only the focus-border update at
        // the end still applies, same as any other untiled window.
        if (win.minimized) {
            const mg = this._managerFor(win);
            if (mg) {
                // Remembered so _reserveWindowTabSpace can still offer a
                // tab for it in whichever slot its app's other windows
                // occupy - a window round-robining into the same slot as
                // others of its own app minimizing used to just vanish
                // from the strip entirely, with no way back into it short
                // of the taskbar/window list, same as it had never shared
                // that slot at all. Cleared the moment it stops being
                // minimized, whichever way that happens (see below, and
                // _onWindowUnmanaged/_untrackWindow/_untrackAll).
                this._minimizedWindowManager.set(win, mg);
                this._removedWindowPosition.set(win, { mg, info: mg.removeWindow(win) });
                this._retile(mg);
            }
        } else {
            this._minimizedWindowManager.delete(win);
            // Same race as a brand-new window (see _onWindowCreated): a
            // restored window regaining focus can fire notify::focus-window
            // - and _updateFocusBorder along with it - before this handler
            // even runs, since Mutter doesn't guarantee notify::minimized
            // and notify::focus-window arrive in a fixed order for the same
            // restore. _pendingTrack covers the case where this handler
            // does get to run first (its own _trackWindow call is
            // synchronous, no first-frame wait needed here unlike a truly
            // new window) - it can't retroactively fix an _updateFocusBorder
            // that already ran before this handler started, but narrows the
            // window either way.
            this._pendingTrack.add(win);
            this._trackWindow(win, true, true);
            this._pendingTrack.delete(win);
        }
        this._updateFocusBorder();
    }

    _onWindowFullscreenChanged(win) {
        if (win.is_fullscreen()) {
            const mg = this._managerFor(win);
            if (mg) {
                // Show its actual fullscreen content, not cropped to the
                // tile slot it just left.
                this._clearClip(win);
                this._removedWindowPosition.set(win, { mg, info: mg.removeWindow(win) });
                this._retile(mg);
            }
        } else {
            this._trackWindow(win, true, true);
        }
        this._updateFocusBorder();
    }

    // Same idea as _onWindowFullscreenChanged just above, for the native
    // maximize button/keybinding instead of fullscreen - used to just
    // _retile() the manager unconditionally, which un-maximizes the window
    // right back via _applyOne's own unmaximize() call (see _applyOne):
    // confirmed live that made every maximize-button click look broken, a
    // half-finished maximize transition or a flash of the wrong slot clip
    // before snapping back into the tile, rather than the window actually
    // maximizing like the button says it will. Clicking maximize should
    // maximize; clicking it again (or restoring via the titlebar/keyboard)
    // should go back into tiling, same round-trip fullscreen already gets.
    _onWindowMaximizedChanged(win) {
        if (!this.tilingEnabled || this._retiling) return;
        if (win.get_maximized() !== 0) {
            const mg = this._managerFor(win);
            if (mg) {
                // Show its actual maximized content, not cropped to the
                // tile slot it just left (see _onWindowFullscreenChanged).
                this._clearClip(win);
                this._removedWindowPosition.set(win, { mg, info: mg.removeWindow(win) });
                // Marks it as deliberately untiled while it stays maximized,
                // same as _floatingWindows does for kb-toggle-floating - see
                // _nativeMaximizedWindows itself for why this is needed.
                this._nativeMaximizedWindows.add(win);
                this._retile(mg);
            }
        } else {
            // _trackWindow's own _isTileable() guard already makes this a
            // no-op for a window explicitly floated (kb-toggle-floating)
            // before ever being maximized - passing through a maximized
            // state on the way shouldn't silently pull a floating window
            // back into the grid.
            this._nativeMaximizedWindows.delete(win);
            // Grabbing a maximized window's titlebar and dragging it down
            // un-maximizes it *as the move grab starts* - Mutter's own
            // native "unsnap" gesture - with the mouse button still held
            // for the rest of that same drag. Forcing an immediate
            // synchronous retile()/move_resize_frame() right here would
            // snap it straight into its tile slot geometry while Mutter's
            // own grab is still actively driving that exact window,
            // fighting the live drag the same way _settleGeometryChange
            // already goes out of its way to avoid for a plain drag/resize
            // (see there, and _pollForDragRelease) - a forced geometry
            // change mid-grab desyncs the grab's own notion of the
            // window's size/position from reality, which is consistent
            // with a window left at the wrong (tile) height afterward and
            // no longer resizing correctly by mouse until released and
            // re-grabbed. While the button is still held, just track it
            // into its manager without forcing geometry yet (retile/raise
            // both false) - the window is still actively moving right now,
            // so _onWindowGeometryChanged's own debounce/button-held poll
            // (already connected, see _attachWindowSignals) picks it up
            // from here and commits the real tile geometry itself, only
            // once the button is actually released. A genuine discrete
            // unmaximize (the restore button, a keybinding, no button
            // held) still retiles immediately as before. Also starts the
            // same release poll _settleGeometryChange itself relies on
            // (_pollForDragRelease) as a safety net for the button-held
            // read being a false positive here (e.g. a double-click
            // restore briefly reading as held between the two clicks) -
            // without it, and with no further geometry-changed event ever
            // arriving to pick this window back up, it would stay tracked
            // but stuck at its just-unmaximized geometry indefinitely,
            // instead of ever actually landing in its tile slot.
            const dragging = this._pointerButtonHeld();
            this._trackWindow(win, !dragging, !dragging);
            if (dragging) this._pollForDragRelease(win);
        }
        this._updateFocusBorder();
    }

    _pointerButtonHeld() {
        const [, , mods] = global.get_pointer();
        return (
            (mods &
                (Clutter.ModifierType.BUTTON1_MASK | Clutter.ModifierType.BUTTON2_MASK | Clutter.ModifierType.BUTTON3_MASK)) !==
            0
        );
    }

    // Fires continuously while a window is being dragged or resized (Mutter
    // has no reliable grab-op-begin/end signal in this environment - it
    // never fired for a single real drag while testing, despite a clear
    // stream of position-changed events - so reacting live and racing the
    // drag isn't an option here). Instead, debounce: every event restarts a
    // short timer, and only once movement actually stops does
    // _settleGeometryChange() run.
    _onWindowGeometryChanged(win) {
        if (!this.tilingEnabled || this._retiling) return;
        // A floating window (kb-toggle-floating) is deliberately left
        // entirely alone geometry-wise - explicitly untiled specifically so
        // the user can freely move/resize it - but it still keeps this same
        // signal hookup (_toggleFloating never detaches it, only removes it
        // from its manager). Its own screen position doesn't matter to a
        // strip anymore either way: strips live among real window actors
        // now (see _restackWindowTabStrip), so a floating window raised
        // above one - which moving/focusing it always does - already paints
        // over it and receives its own clicks correctly, the same as any
        // other pair of overlapping windows.
        if (!this._managerFor(win)) return;

        // A mouse button being physically held is the one thing a client
        // resizing/repositioning itself can never fake - if it's ever held
        // during this burst of events, this is almost certainly a genuine
        // user drag; if it's never held throughout, nothing the user did
        // caused this (most commonly: an app asynchronously moving/resizing
        // itself back to its own preferred geometry a moment after being
        // tiled - confirmed on Mailspring, sshpilot and TelegramDesktop by
        // calling move_resize_frame() directly with no kortile logic
        // involved at all and watching it drift back on its own). This is
        // checked on every event, not just at debounce-fire time, since the
        // button may already be released by the time the debounce settles.
        if (this._pointerButtonHeld()) {
            this._dragFlag.set(win, true);
        }

        // The slot clip (see _applyOne) is sized for whatever geometry was
        // last committed - stale the moment the *current* geometry no
        // longer matches that, whether from a live held-button drag or an
        // app drifting back to its own preferred size entirely on its own
        // (see _commitGeometryChange's stubborn-app path, sshpilot et al
        // above) - confirmed live on both: leaving the *old* clip active
        // crops whatever part of the new geometry falls outside it, for as
        // long as it takes the correction to land (a full debounce cycle
        // plus the async clip-settle poll on top for the drift case, since
        // nothing there holds a button down to shorten it). Only clear it
        // for a *real* change though - most events landing here are just
        // this window's own move_resize_frame() (ours) echoing back
        // exactly what was just applied, and clearing on every one of
        // those would leave it permanently unclipped, since nothing else
        // re-clips a no-op commit (_commitGeometryChange bails out before
        // ever calling _applyOne again if nothing actually changed).
        const lastApplied = this._lastAppliedRect.get(win);
        const curRect = win.get_frame_rect();
        const isRealChange =
            !lastApplied ||
            curRect.x !== lastApplied.x ||
            curRect.y !== lastApplied.y ||
            curRect.width !== lastApplied.w ||
            curRect.height !== lastApplied.h;
        if (isRealChange) {
            this._clearClip(win);
        }

        // Short enough that a window fighting the tile (see
        // _commitGeometryChange) gets pulled back within well under a
        // tenth of a second of drifting - long enough that a real drag,
        // whose events fire much faster than this, never gets cut off
        // mid-motion (only after the last event does this fire at all).
        this._cancelGeometryDebounce(win);
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            this._geometryDebounce.delete(win);
            this._settleGeometryChange(win);
            return GLib.SOURCE_REMOVE;
        });
        this._geometryDebounce.set(win, id);
    }

    _cancelGeometryDebounce(win) {
        const id = this._geometryDebounce.get(win);
        if (id) {
            GLib.source_remove(id);
            this._geometryDebounce.delete(win);
        }
    }

    // Movement has been quiet for a moment, but that alone doesn't mean the
    // user let go of the mouse - a real drag/resize very often has brief
    // pauses (lining up an edge, hesitating) well over the 60ms debounce
    // without releasing the button. Committing here anyway - calling
    // move_resize_frame() while Mutter's own interactive grab is still
    // driving that exact window - fights that live grab: confirmed live
    // that this is what caused resized windows to intermittently flash
    // transparent (a stale actor position mid-fight desyncs the slot clip
    // from the actual frame for a frame or two) and made the drag feel
    // like it barely responded, especially for vertical/height resizes.
    // If a button is still down, don't touch geometry - wait for it to
    // actually come up instead (polled, since grab-op-end isn't reliable
    // here either), then commit once.
    _settleGeometryChange(win) {
        if (this._pointerButtonHeld()) {
            this._pollForDragRelease(win);
            return;
        }
        this._commitGeometryChange(win);
    }

    _pollForDragRelease(win) {
        if (this._releasePoll.has(win)) return;
        let ticks = 0;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (!this.tilingEnabled || !this._managerFor(win)) {
                this._releasePoll.delete(win);
                return GLib.SOURCE_REMOVE;
            }
            // 20s safety cap - get_pointer()'s modifier mask has been
            // reliable in testing (even under synthetic xdotool input), but
            // never poll forever if a button somehow gets stuck reporting
            // held; commit whatever is current instead of leaving the
            // window unmanaged-by-the-tile indefinitely.
            if (this._pointerButtonHeld() && ++ticks < 400) return GLib.SOURCE_CONTINUE;
            this._releasePoll.delete(win);
            this._commitGeometryChange(win);
            return GLib.SOURCE_REMOVE;
        });
        this._releasePoll.set(win, id);
    }

    _cancelDragReleasePoll(win) {
        const id = this._releasePoll.get(win);
        if (id) {
            GLib.source_remove(id);
            this._releasePoll.delete(win);
        }
    }

    // The one commit decision, made once movement has settled:
    //  - moved to a different monitor/workspace -> reassign to that tiling
    //    (always, regardless of drag detection - could be a keybinding).
    //  - not a drag (no button held throughout) -> a window can't drag
    //    itself, so whatever caused this wasn't the user; accept the
    //    window's own geometry instead of fighting it forever.
    //  - size changed -> plain resize, snap back to the tile.
    //  - position only changed -> dropped onto another tracked window, swap
    //    grid slots instead of leaving it wherever the pointer released it
    //    with an empty slot behind.
    _commitGeometryChange(win) {
        if (!this.tilingEnabled || this._retiling) return;
        let mg = this._managerFor(win);
        if (!mg) return;

        const wasDragged = this._dragFlag.get(win) === true;
        this._dragFlag.delete(win);
        const [pointerX, pointerY] = global.get_pointer();

        // win.get_monitor() picks whichever monitor has the *largest
        // overlap area* with the window's own frame rect (confirmed live
        // via global.display.get_monitor_index_for_rect(), the primitive
        // it's built on: a rect at y=700, 1356 tall, landed on monitor 0 -
        // 740px of it above the y=1440 boundary against 616 below; the
        // same rect at y=800 flipped to monitor 2, 640 above against 716
        // below) - not the cursor. A window taller than the gap to a
        // monitor sitting directly below/right of the current one (the
        // master column in vertical-left/right is a common case, being as
        // tall as the whole work area) dragged toward a slot near that
        // edge can easily end up with more of its own height past the
        // boundary than short of it, even though the cursor doing the
        // dragging never left the monitor the user was actually working
        // on - reassigned the *window* to the other monitor's manager
        // entirely, rather than doing the in-place slot swap the user was
        // aiming for. Only matters for a genuine drag - win.get_monitor()
        // is still the only sensible read for an app repositioning itself
        // with no user input involved at all (the !wasDragged path below),
        // there's no cursor to speak of for that case.
        const monIndex = wasDragged
            ? global.display.get_monitor_index_for_rect(new Meta.Rectangle({ x: pointerX, y: pointerY, width: 1, height: 1 }))
            : win.get_monitor();
        const ws = win.get_workspace();
        const wsIndex = this._wsIndexForMonitor(monIndex, ws ? ws.index() : mg.workspaceIndex);
        if (monIndex !== mg.monitorIndex || wsIndex !== mg.workspaceIndex) {
            mg.removeWindow(win);
            this._retile(mg);
            mg = this._getOrCreateManager(wsIndex, monIndex);
            mg.addWindow(win);
            this._retile(mg);
            return;
        }

        const last = this._lastAppliedRect.get(win);
        if (!last) return;
        const cur = win.get_frame_rect();

        const sizeChanged = cur.width !== last.w || cur.height !== last.h;
        const posChanged = cur.x !== last.x || cur.y !== last.y;
        if (!sizeChanged && !posChanged) {
            this._stubbornCount.delete(win); // settled exactly where we put it
            return;
        }

        if (!wasDragged) {
            // Nothing the user did caused this - most commonly an app
            // asynchronously moving/resizing itself back to its own
            // preferred geometry a moment after being tiled (confirmed on
            // Mailspring, sshpilot and TelegramDesktop). Mutter gives an
            // extension no veto power over a client's own resize, so
            // "accept and move on" was tried first - but that lets such a
            // window grow past its slot and visually break the grid, which
            // is exactly what should never happen. Pull it back into its
            // slot immediately, and if it keeps happening, start a
            // low-frequency watchdog that keeps re-asserting the slot
            // geometry for as long as this window keeps drifting.
            const wa = this._workAreaRect(mg);
            const rects = wa ? mg.compute(wa, this.gapSize || 0, (w) => this._windowGroupKey(w)) : null;
            if (rects) this._reserveWindowTabSpace(mg, rects);
            const target = rects ? rects.get(win) : null;
            this._applyOne(win, target || rectFromMeta(cur), false);
            this._startEnforcing(win);
            return;
        }

        // Kept as a second line of defense: Mutter doesn't give an
        // extension veto power over a client's own ConfigureRequest the way
        // a standalone X11 window manager (i3, bspwm) can, so even a
        // detected drag could in principle still be fought by the app.
        // This can only fire on a *complete* drag (wasDragged requires the
        // button to have actually been held, and commits only run after
        // release), so 3 of those in a row within the window below means 3
        // separate press-drag-release cycles - a short window keeps this
        // aimed at an app fighting back within a couple hundred ms of each
        // release, without also swallowing a user's own quick series of
        // deliberate manual adjustments (each takes at least a few hundred
        // ms of its own).
        const entry = this._stubbornCount.get(win) || { count: 0, lastAt: 0 };
        const now = Date.now();
        const count = now - entry.lastAt < 800 ? entry.count + 1 : 1;
        this._stubbornCount.set(win, { count, lastAt: now });
        if (count > 2) {
            global.logWarning(
                `[${this.uuid}] ${win.get_wm_class()} keeps resisting its tile geometry - leaving it as-is for now`
            );
            this._lastAppliedRect.set(win, rectFromMeta(cur));
            return;
        }

        if (sizeChanged) {
            // Manually resizing a tiled window's edge translates the drag
            // into a proportion change instead of just fighting it back to
            // the old size: either the master/slave divide, or (if there
            // are multiple windows stacked in the same group) the boundary
            // between two stacked windows.
            this._updateProportionFromResize(mg, win, cur, last);
            this._updateStackProportionFromResize(mg, win, cur, last);
        } else if (posChanged) {
            // The dragged window's own geometric center, not the actual
            // cursor, used to decide the swap target - confirmed live this
            // picks the wrong slot whenever the window is large enough (or
            // the drop is close enough to a slot boundary) that its center
            // is still sitting over a different slot than the one visibly
            // under the mouse at drop time, e.g. dropping onto the
            // top-right slave still swapping with the middle one because
            // the dragged window's center hadn't actually crossed into the
            // top-right slot's area yet. The pointer is what the user is
            // actually aiming with - global.get_pointer() here reads its
            // position at commit time, i.e. right around release, matching
            // where they visually dropped it (see wasDragged just above -
            // this only ever runs once the button is confirmed up). Reuses
            // the same read taken at the top of this function (for the
            // monitor check) rather than reading it again - the pointer
            // hasn't moved between the two, no reason to risk the two
            // decisions disagreeing over a read taken microseconds apart.
            const target = this._windowAtPoint(mg, { x: pointerX, y: pointerY }, win);
            // Group-aware (see Manager.swap) - dropping onto a window that
            // shares its slot with others (same app, round-robined
            // together) swaps win with that *whole slot*, not just the one
            // window under the pointer, so a groupmate can't get left
            // behind in the wrong spot or dragged somewhere it wasn't
            // dropped.
            if (target) mg.swap(win, target, (w) => this._windowGroupKey(w));
        }

        this._retile(mg);
    }

    // Infers which edge of win was dragged from the position/size delta
    // (Mutter's grab-op signals aren't reliable in this environment, see
    // _onWindowGeometryChanged, but a resize always moves exactly one edge:
    // the one that moved keeps the *opposite* edge fixed, so "did x change"
    // alone tells left vs right apart, same for y/top vs bottom) and, if
    // that's the edge sitting on the master/slave boundary, sets the ratio
    // to match where the user actually dropped it - a plain, non-boundary
    // edge resize (e.g. a slave's outer edge) is left alone; _retile()
    // still snaps it back to the tile afterwards either way.
    _updateProportionFromResize(mg, win, cur, last) {
        if (mg.layout === "maximized" || mg.slaves.length === 0) return;

        const isMaster = mg.masters.includes(win);
        const isSlave = !isMaster && mg.slaves.includes(win);
        if (!isMaster && !isSlave) return;

        const vertical = mg.layout.startsWith("vertical");
        const masterFirst = mg.layout === "vertical-left" || mg.layout === "horizontal-top";

        // A real interactive Mutter resize can settle a pixel or two off
        // from an exact match on the axis that's supposed to be fixed
        // (rounding in its own constraint solver, unlike calling
        // move_resize_frame() directly) - a strict === here made a
        // boundary-edge drag intermittently get misread as "not the
        // boundary edge" and silently snap back with no ratio change at
        // all. A couple of pixels of slack is well below anything a real
        // drag would produce on purpose.
        const TOLERANCE = 2;
        const leadingChanged = vertical ? Math.abs(cur.x - last.x) > TOLERANCE : Math.abs(cur.y - last.y) > TOLERANCE;
        const trailingChanged = vertical
            ? Math.abs(cur.x - last.x) <= TOLERANCE && Math.abs(cur.width - last.w) > TOLERANCE
            : Math.abs(cur.y - last.y) <= TOLERANCE && Math.abs(cur.height - last.h) > TOLERANCE;

        const boundaryIsLeading = masterFirst ? isSlave : isMaster;
        if (boundaryIsLeading && !leadingChanged) return;
        if (!boundaryIsLeading && !trailingChanged) return;

        const wa = this._workAreaRect(mg);
        if (!wa) return;
        const area = shrink(wa, this.gapSize || 0);
        const total = Math.max((vertical ? area.w : area.h) - (this.gapSize || 0), 1);

        const winSize = vertical ? cur.width : cur.height;
        const masterSize = isMaster ? winSize : total - winSize;
        const masterFraction = masterSize / total;
        mg.setProportion(masterFirst ? masterFraction : 1 - masterFraction, this.proportionMin || 0.1);
    }

    // Same idea as _updateProportionFromResize, but for the boundary
    // *between two windows stacked in the same group* (multiple masters,
    // or multiple visible slaves) rather than the master/slave divide -
    // e.g. two slaves stacked top-to-bottom in a vertical-left/right
    // layout. The stack axis is whichever one the master/slave split
    // *isn't* (top-to-bottom for vertical layouts, left-to-right for
    // horizontal ones).
    _updateStackProportionFromResize(mg, win, cur, last) {
        if (mg.layout === "maximized") return;

        const inMasters = mg.masters.includes(win);
        if (!inMasters && !mg.slaves.includes(win)) return;
        const list = inMasters ? mg.masters : mg.slaves;
        const kind = inMasters ? "master" : "slave";

        // Every master shares one identical rect now (see Manager.compute)
        // rather than getting its own stacked column, so there's never a
        // boundary *between* two masters to drag - only overflow slaves
        // beyond slavesMax share a visible slot round-robin, and even
        // there a shared slave's own index in mg.slaves isn't a real stack
        // *position* once slavesMax has capped the visible count, so this
        // only applies within the visible range.
        const visibleCount = inMasters ? 1 : Math.max(1, Math.min(list.length, mg.slavesMax));
        const idx = list.indexOf(win);
        if (idx < 0 || idx >= visibleCount || visibleCount < 2) return;

        const vertical = mg.layout.startsWith("vertical");
        const stackAxis = vertical ? "y" : "x";
        const TOLERANCE = 2;
        const leadingChanged = stackAxis === "y" ? Math.abs(cur.y - last.y) > TOLERANCE : Math.abs(cur.x - last.x) > TOLERANCE;
        const trailingChanged = stackAxis === "y"
            ? Math.abs(cur.y - last.y) <= TOLERANCE && Math.abs(cur.height - last.h) > TOLERANCE
            : Math.abs(cur.x - last.x) <= TOLERANCE && Math.abs(cur.width - last.w) > TOLERANCE;

        const wa = this._workAreaRect(mg);
        if (!wa) return;
        const rects = mg.compute(wa, this.gapSize || 0, (w) => this._windowGroupKey(w));
        this._reserveWindowTabSpace(mg, rects);

        let boundaryIdx, itemStart, itemSize;
        if (idx > 0 && leadingChanged) {
            // Dragged this window's leading edge, which is the previous
            // stack item's trailing edge - that item's own leading edge is
            // fixed, so its new size is just the distance from there to
            // wherever this shared boundary just moved to.
            const prevRect = rects.get(list[idx - 1]);
            if (!prevRect) return;
            boundaryIdx = idx - 1;
            itemStart = stackAxis === "y" ? prevRect.y : prevRect.x;
            itemSize = (stackAxis === "y" ? cur.y : cur.x) - itemStart;
        } else if (idx < visibleCount - 1 && trailingChanged) {
            boundaryIdx = idx;
            itemStart = stackAxis === "y" ? cur.y : cur.x;
            itemSize = stackAxis === "y" ? cur.height : cur.width;
        } else {
            return;
        }

        // The pool boundaryIdx's ratio splits runs from itemStart to the
        // far edge of the whole stack (the last visible item's own far
        // edge, from the pre-drag layout).
        const lastRect = rects.get(list[visibleCount - 1]);
        if (!lastRect) return;
        const stackEnd = stackAxis === "y" ? lastRect.y + lastRect.h : lastRect.x + lastRect.w;
        const poolSize = Math.max(stackEnd - itemStart, 1);

        mg.setStackProportion(kind, boundaryIdx, itemSize / poolSize, this.proportionMin || 0.1);
    }

    // Keyboard equivalent of dragging a stack-internal boundary (see
    // _updateStackProportionFromResize) - grows or shrinks the focused
    // window against its neighbor in the same stack (master or slave
    // group), without needing to grab any edge with the mouse at all. Uses
    // the boundary after this window if it has one, otherwise the boundary
    // before it (i.e. it's the last item in the stack).
    _adjustStackProportion(mg, win, step, dir) {
        const inMasters = mg.masters.includes(win);
        if (!inMasters && !mg.slaves.includes(win)) return;
        const list = inMasters ? mg.masters : mg.slaves;
        const kind = inMasters ? "master" : "slave";

        // See _updateStackProportionFromResize - masters all share one
        // rect now, so there's never a boundary between them to adjust.
        const visibleCount = inMasters ? 1 : Math.max(1, Math.min(list.length, mg.slavesMax));
        const idx = list.indexOf(win);
        if (idx < 0 || idx >= visibleCount || visibleCount < 2) return;

        const boundaryIdx = idx < visibleCount - 1 ? idx : idx - 1;
        const ratios = kind === "master" ? mg.masterRatios : mg.slaveRatios;
        const current = ratios[boundaryIdx] !== undefined ? ratios[boundaryIdx] : 1 / (visibleCount - boundaryIdx);

        // ratios[boundaryIdx] is list[boundaryIdx]'s own share - if this
        // window sits *after* that boundary (it's the stack's last item,
        // using the boundary before it), growing this window means
        // shrinking the neighbor's ratio instead of its own.
        const sign = boundaryIdx === idx ? 1 : -1;
        mg.setStackProportion(kind, boundaryIdx, current + sign * dir * step, this.proportionMin || 0.1);
        this._retile(mg);
    }

    _onWorkspaceSwitched(manager, fromIndex, toIndex) {
        this._cancelWorkspaceSwitchRetile();

        // Showing/hiding an already-built strip touches nothing about
        // window geometry (see _updateWindowTabVisibility) - nothing here
        // needs to wait out Cinnamon's own slide animation the way the
        // geometry retile below does, and get_active_workspace_index()
        // already reports toIndex the instant this signal fires, well
        // before the animation finishes. Doing it right away instead of
        // leaving it bundled into the delayed retileNow() below is what
        // makes tabs switch the moment you land on a workspace instead of
        // visibly lagging behind by the same 300ms the geometry needs.
        this._updateWindowTabVisibility();

        const retileNow = () => {
            for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
                const wsIndex = this._wsIndexForMonitor(i, toIndex);
                const mg = this._managers.get(this._managerKey(wsIndex, i));
                if (mg) this._retile(mg);
            }
            this._syncMenu();
            this._updateFocusBorder();
        };

        if (!Main.animations_enabled) {
            retileNow();
            return;
        }

        // Cinnamon's own workspace-switch effect (windowManager.js
        // _switchWorkspace) animates every window actor's position
        // directly and relies on that tween's onComplete to reveal/hide
        // windows and signal completed_switch_workspace(). Retiling
        // immediately here races that in-flight tween: _applyOne's own
        // slide animation calls actor.remove_all_transitions() first,
        // which kills Cinnamon's tween mid-flight, so its onComplete (and
        // therefore completed_switch_workspace()) never fires - confirmed
        // live this is what made every window look like it minimized.
        // Wait out Cinnamon's own transition (150ms base * up to 1.4x on
        // the "slow" window-effect-speed setting - 300ms comfortably
        // covers that) before touching geometry.
        this._workspaceSwitchRetileId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._workspaceSwitchRetileId = null;
            retileNow();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelWorkspaceSwitchRetile() {
        if (this._workspaceSwitchRetileId) {
            GLib.source_remove(this._workspaceSwitchRetileId);
            this._workspaceSwitchRetileId = null;
        }
    }

    _onMonitorsChanged() {
        this._tileAll();
    }

    // win.activate() alone doesn't reliably bring a window to the front of
    // *real* window stacking order in this environment - confirmed live
    // already this session (see the raiseIt parameter on _trackWindow,
    // added for exactly this after a D-Bus-activated window landed
    // visibly behind its siblings despite Mutter reporting it focused) and
    // reconfirmed live again here: activating a window sharing a slot with
    // others left global.display.sort_windows_by_stacking() still
    // reporting a *different* one on top, so a tab strip's own idea of
    // "which app is currently showing" (see _reserveWindowTabSpace) never
    // updated even though focus genuinely had moved.
    //
    // raise() has to come *first*, not after - confirmed live activate()
    // alone fires notify::focus-window synchronously (this applet's own
    // _onFocusWindowChanged reacts to that by retiling, which is exactly
    // what reads sort_windows_by_stacking() to decide which strip to show
    // - see _reserveWindowTabSpace), so a raise() called *after* activate()
    // lands too late: that retile already ran and read the still-stale
    // stacking order in between the two calls.
    _activateAndRaise(win) {
        // A tab for a minimized window (see _reserveWindowTabSpace) needs
        // this explicitly - raise()/activate() alone don't reliably bring
        // a minimized window back on their own here, same "don't assume
        // the obvious Mutter call does the obvious thing" story as
        // raise()-before-activate() below.
        if (win.minimized) win.unminimize();
        win.raise();
        win.activate(global.get_current_time());
    }

    // ---- actions (keybindings + menu) ----

    // useFocusWindow: keybindings act on whatever window the user is
    // currently working in, even if that's on a different monitor than the
    // mouse pointer. Menu clicks pass useFocusWindow: false instead, so
    // they always target the same (pointer/current-monitor) manager that
    // _syncMenu() displays the state of - otherwise a focused window on
    // another monitor than the one the tray/mouse is on would make a menu
    // click silently retile a manager other than the one its own switches
    // are showing, so the switch you just clicked would never move.
    _onAction(action, { useFocusWindow = true } = {}) {
        if (action === "toggle") {
            this._toggle();
            this._syncMenu();
            return;
        }
        if (!this.tilingEnabled) return;

        const win = useFocusWindow ? global.display.focus_window : null;
        const mg = (win && this._managerFor(win)) || this._activeManager();

        switch (action) {
            case "cycle-next":
                this._cycleLayout(mg, 1);
                break;
            case "cycle-previous":
                this._cycleLayout(mg, -1);
                break;
            case "layout-vertical-left":
                this._setLayout(mg, "vertical-left");
                break;
            case "layout-vertical-right":
                this._setLayout(mg, "vertical-right");
                break;
            case "layout-horizontal-top":
                this._setLayout(mg, "horizontal-top");
                break;
            case "layout-horizontal-bottom":
                this._setLayout(mg, "horizontal-bottom");
                break;
            case "layout-maximized":
                this._setLayout(mg, "maximized");
                break;
            case "master-increase":
                mg.increaseMaster();
                this._retile(mg);
                break;
            case "master-decrease":
                mg.decreaseMaster();
                this._retile(mg);
                break;
            case "slave-increase":
                mg.increaseSlave();
                this._retile(mg);
                break;
            case "slave-decrease":
                mg.decreaseSlave();
                this._retile(mg);
                break;
            case "window-next": {
                const n = win && mg.nextWindow(win);
                if (n) this._activateAndRaise(n);
                break;
            }
            case "window-previous": {
                const p = win && mg.previousWindow(win);
                if (p) this._activateAndRaise(p);
                break;
            }
            case "master-make":
                if (win) {
                    mg.makeMaster(win);
                    this._retile(mg);
                }
                break;
            case "toggle-floating":
                if (win) this._toggleFloating(win);
                break;
            case "proportion-increase":
                mg.increaseProportion(this.proportionStep || 0.05, this.proportionMin || 0.1);
                this._retile(mg);
                break;
            case "proportion-decrease":
                mg.decreaseProportion(this.proportionStep || 0.05, this.proportionMin || 0.1);
                this._retile(mg);
                break;
            case "stack-proportion-increase":
                if (win) this._adjustStackProportion(mg, win, this.proportionStep || 0.05, 1);
                break;
            case "stack-proportion-decrease":
                if (win) this._adjustStackProportion(mg, win, this.proportionStep || 0.05, -1);
                break;
            case "restore":
                this._restoreManager(mg);
                break;
            case "reset":
                mg.reset(1, 0.5);
                this._retile(mg);
                break;
            case "minimized-switcher":
                this._toggleMinimizedSwitcher(mg);
                break;
        }
        this._syncMenu();
    }

    // ---- minimized-window switcher ----

    // With no panel/taskbar on screen, a workspace where every window
    // happens to be minimized has nothing left to click to get anything
    // back, short of Alt+Tab - this is the other way in. Lists exactly the
    // set _minimizedWindowManager remembers for mg (the same set
    // _reserveWindowTabSpace would offer a tab for, if there were anything
    // left on screen for that tab's strip to attach to), Up/Down to move
    // the selection, Enter or a click to restore and focus it, Escape or a
    // click elsewhere to close without doing anything. A second press while
    // it's already open just closes it, same toggle convention kb-toggle-
    // floating uses for its own action.
    _toggleMinimizedSwitcher(mg) {
        if (this._minimizedSwitcher) {
            this._closeMinimizedSwitcher();
            return;
        }
        const wins = [];
        for (const [win, ownerMg] of this._minimizedWindowManager) {
            if (ownerMg === mg) wins.push(win);
        }
        if (wins.length === 0) return;
        this._openMinimizedSwitcher(mg, wins);
    }

    _openMinimizedSwitcher(mg, wins) {
        const actor = new St.BoxLayout({
            vertical: true,
            reactive: true,
            style: `spacing: 2px; padding: 4px; min-width: ${MINIMIZED_SWITCHER_MIN_WIDTH}px; background-color: ${this._windowTabBackgroundColor()}; border-radius: 6px;`,
        });
        Main.uiGroup.add_actor(actor);

        const rows = wins.map((win) => ({ actor: this._createMinimizedSwitcherRow(win), win }));
        for (const row of rows) actor.add_actor(row.actor);

        // Same modal grab as the window picker/tab rename (Main.pushModal
        // alone doesn't route real input to a plain chrome actor - see
        // _startWindowRename's own comment on this) - captured-event on the
        // stage is what actually sees Up/Down/Enter/Escape and clicks
        // landing outside the popup.
        Main.pushModal(actor);
        const capturedId = global.stage.connect("captured-event", (a, event) => this._onMinimizedSwitcherEvent(event));
        this._minimizedSwitcher = { actor, rows, selectedIndex: 0, capturedId };
        this._restyleMinimizedSwitcher();

        const monitor = Main.layoutManager.monitors[mg.monitorIndex] || Main.layoutManager.primaryMonitor;
        const [, naturalWidth] = actor.get_preferred_width(-1);
        const [, naturalHeight] = actor.get_preferred_height(naturalWidth);
        actor.set_position(
            monitor.x + Math.floor((monitor.width - naturalWidth) / 2),
            monitor.y + Math.floor((monitor.height - naturalHeight) / 2)
        );
        actor.grab_key_focus();
    }

    _createMinimizedSwitcherRow(win) {
        const app = Cinnamon.WindowTracker.get_default().get_window_app(win);
        const icon = app
            ? app.create_icon_texture(MINIMIZED_SWITCHER_ICON_SIZE)
            : new St.Icon({ icon_name: "application-x-executable", icon_size: MINIMIZED_SWITCHER_ICON_SIZE });
        const label = new St.Label({ text: this._windowTabTitle(win) });
        label.style = `color: ${this._windowTabForegroundHex()};`;
        const box = new St.BoxLayout({ style: "spacing: 8px;" });
        box.add_actor(icon);
        box.add_actor(label);

        const btn = new St.Button({ child: box, reactive: true, track_hover: true, x_expand: true, x_fill: true });
        btn.connect("enter-event", () => this._selectMinimizedSwitcherWindow(win));
        btn.connect("clicked", () => this._activateMinimizedSwitcherRow(win));
        return btn;
    }

    _restyleMinimizedSwitcher() {
        const sw = this._minimizedSwitcher;
        if (!sw) return;
        sw.rows.forEach((row, i) => {
            const alpha = i === sw.selectedIndex ? 0.28 : 0.06;
            row.actor.style = `padding: ${MINIMIZED_SWITCHER_ROW_PADDING}px; border-radius: 4px; background-color: ${this._windowTabForegroundRgba(alpha)};`;
        });
    }

    _selectMinimizedSwitcherWindow(win) {
        const sw = this._minimizedSwitcher;
        if (!sw) return;
        const idx = sw.rows.findIndex((row) => row.win === win);
        if (idx < 0) return;
        sw.selectedIndex = idx;
        this._restyleMinimizedSwitcher();
    }

    _moveMinimizedSwitcherSelection(delta) {
        const sw = this._minimizedSwitcher;
        if (!sw) return;
        const n = sw.rows.length;
        sw.selectedIndex = (sw.selectedIndex + delta + n) % n;
        this._restyleMinimizedSwitcher();
    }

    _activateMinimizedSwitcherSelection() {
        const sw = this._minimizedSwitcher;
        if (!sw) return;
        const row = sw.rows[sw.selectedIndex];
        if (row) this._activateMinimizedSwitcherRow(row.win);
    }

    // Restoring here is exactly _activateAndRaise, the same unminimize/
    // raise/activate sequence a tab click already uses to bring back a
    // minimized window sharing a live slot - closing first so the popup
    // itself is never in the way of (or briefly visible on top of) the
    // window it just brought back.
    _activateMinimizedSwitcherRow(win) {
        this._closeMinimizedSwitcher();
        this._activateAndRaise(win);
    }

    _closeMinimizedSwitcher() {
        const sw = this._minimizedSwitcher;
        if (!sw) return;
        this._minimizedSwitcher = null;
        // Same defensive try/catch as _stopWindowPicker: popModal can throw
        // ("incorrect pop") if the modal stack was disturbed by something
        // else in the meantime - still tear down the rest of this state
        // either way so a stuck switcher can't wedge input to everything
        // behind it.
        try {
            global.stage.disconnect(sw.capturedId);
            Main.popModal(sw.actor);
        } catch (e) {
            global.logWarning(`[${this.uuid}] error closing minimized switcher: ${e}`);
        }
        sw.actor.destroy();
    }

    // Swallows every key while open (same as the window picker does for its
    // own modal grab) rather than only ever intercepting the handful it
    // actually understands - nothing behind this popup should react to
    // stray keystrokes aimed at picking something from it. A click is only
    // special-cased when it lands *outside* the popup (closes it); one
    // landing inside is deliberately left to propagate so the row's own
    // St.Button handles it (enter-event for hover/selection, "clicked" for
    // activation) exactly like it would with no modal grab involved at all.
    _onMinimizedSwitcherEvent(event) {
        const sw = this._minimizedSwitcher;
        if (!sw) return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        if (type === Clutter.EventType.KEY_PRESS) {
            const sym = event.get_key_symbol();
            if (sym === Clutter.KEY_Escape) {
                this._closeMinimizedSwitcher();
            } else if (sym === Clutter.KEY_Down) {
                this._moveMinimizedSwitcherSelection(1);
            } else if (sym === Clutter.KEY_Up) {
                this._moveMinimizedSwitcherSelection(-1);
            } else if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
                this._activateMinimizedSwitcherSelection();
            }
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_PRESS) {
            if (sw.actor.contains(event.get_source())) return Clutter.EVENT_PROPAGATE;
            this._closeMinimizedSwitcher();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // Same idea as other tiling WMs' "toggle floating": pull the focused
    // window out of the grid (it keeps whatever geometry it currently has,
    // free to move/resize normally) without touching its neighbors' layout
    // beyond closing the gap it leaves behind, or put it back in. Unlike
    // "Restore" this isn't permanent and doesn't reset geometry - toggling
    // back re-tiles it into its current monitor/workspace's manager same as
    // any newly-opened window would be. Floating windows already get the
    // focus border like any other untiled window (see _updateFocusBorder).
    _toggleFloating(win) {
        const mg = this._managerFor(win);
        if (mg) {
            this._removedWindowPosition.set(win, { mg, info: mg.removeWindow(win) });
            this._retile(mg);
            this._floatingWindows.add(win);
            // A tiled window's actor carries a permanent Clutter clip sized
            // to its slot (see _applyOne) - leaving it on here would crop
            // any part of the window that grows past those old bounds the
            // moment it's freely moved/resized while floating, which looks
            // exactly like the window's edge randomly turning transparent.
            this._clearClip(win);
            // Its own geometry doesn't change just from leaving the
            // manager, so no size/position-changed fires to refresh the
            // border on its own - do it explicitly.
            this._updateFocusBorder();
            return;
        }
        // Only re-tile a window *this* toggle floated - one that's untracked
        // for some other reason (ignore-list, a dialog, ...) is left alone,
        // same as it would be for any other window that isn't tracked.
        if (!this._floatingWindows.has(win)) return;
        this._floatingWindows.delete(win);
        this._trackWindow(win, true, true);
        this._updateFocusBorder();
    }

    _cycleLayout(mg, dir) {
        if (!mg) return;
        const idx = LAYOUTS.indexOf(mg.layout);
        mg.layout = LAYOUTS[(idx + dir + LAYOUTS.length) % LAYOUTS.length];
        this._rememberLayoutFor(mg);
        this._retile(mg);
    }

    _setLayout(mg, layout) {
        if (!mg) return;
        mg.layout = layout;
        this._rememberLayoutFor(mg);
        this._retile(mg);
    }

    _toggle() {
        this.tilingEnabled = !this.tilingEnabled;
        // setValue() only reaches other processes (xlet-settings) - it's a
        // no-op for our own bound callback here (that only fires on an
        // *external* change, e.g. flipping this same checkbox from the
        // Settings window instead of this panel menu/keybinding), so this
        // still has to apply the state change itself.
        this._settings.setValue("enabled", this.tilingEnabled);
        this._applyTilingEnabledState();
    }

    // Shared by both ways this setting can change: the panel menu/keybinding
    // (_toggle, in-process) and Settings window/xlet-settings (external,
    // reaches here via the "enabled" bind callback below instead). Confirmed
    // live these used to diverge - flipping "Enable tiling" off then back on
    // from the Settings window (rather than this applet's own panel menu)
    // updated the checkbox and the in-process property, but never actually
    // re-tracked anything: every currently open window was left floating
    // with no obvious cause, since _syncMenu (the old callback here) only
    // refreshes what the menu displays.
    _applyTilingEnabledState() {
        if (this.tilingEnabled) {
            this._trackExisting();
            this._tileAll();
            this._updateFocusBorder();
            this._startUntrackedWindowSweep();
        } else {
            this._untrackAll(true);
            this._stopUntrackedWindowSweep();
        }
    }

    // Safety net for a real bug that's hard to pin to one exact cause:
    // _onWindowCreated's own track() runs once, at first-frame (or a 50ms
    // fallback) - if _isTileable said no at that exact moment, nothing
    // else ever asks again, since a window that fails it there gets no
    // signal hookup at all (_attachWindowSignals only happens inside
    // _trackWindow, past that same check). Confirmed live with a
    // Chromium/PyPI window: sitting there fully _isTileable (not
    // ignore-listed, not skip-taskbar, no transient parent, not floating)
    // yet with no manager and no window-signal hookup at all - not
    // "kortile decided against it", genuinely never tracked in the first
    // place. Most likely some property Chromium sets briefly during a
    // window's own setup (transient-for while it's still detaching from
    // whatever opened it, easily still true right at first-frame) rather
    // than anything wrong with the check itself, which is why this can't
    // just fix that one moment - a low-frequency sweep catches whatever's
    // eligible *now* but was missed back then, self-healing within a few
    // seconds of whatever transient condition cleared, same idea
    // _startEnforcing's own watchdog already uses for a different gap.
    _startUntrackedWindowSweep() {
        if (this._untrackedSweepId) return;
        this._untrackedSweepId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            if (!this.tilingEnabled) {
                this._untrackedSweepId = null;
                return GLib.SOURCE_REMOVE;
            }
            // Same _isTileable/_managerFor guards _trackWindow already
            // checks internally before doing anything - relying on those
            // instead of repeating them here, same as _trackExisting does,
            // means this is a harmless no-op for every window that's
            // already tracked or still genuinely ineligible.
            for (const actor of global.get_window_actors()) {
                this._trackWindow(actor.get_meta_window(), true, true);
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopUntrackedWindowSweep() {
        if (this._untrackedSweepId) {
            GLib.source_remove(this._untrackedSweepId);
            this._untrackedSweepId = null;
        }
    }

    _onTilingEnabledSettingChanged() {
        this._applyTilingEnabledState();
        this._syncMenu();
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new KortileApplet(metadata, orientation, panel_height, instance_id);
}
