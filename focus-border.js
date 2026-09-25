// Focus border: a configurable-color/width outline around the currently
// focused window, for apps with no border of their own - see applet.js's
// own "Focus border" feature description in README. Unlike manager.js this
// is deliberately NOT Meta/Clutter-free - it owns a real Clutter actor and
// Meta.Window signal connections, so (unlike that one) it can only ever run
// inside the Cinnamon/GJS runtime, not under plain
// node. Split out into its own file anyway, purely to keep this one
// cohesive feature's ~110 lines out of applet.js's own already very large
// class body - applet.js still owns all the settings/trigger wiring
// (constructor `_settings.bind()` calls, and every place something that
// might change what should be outlined calls update()/hide()); this class
// only does the actual positioning work whenever asked to.
const Main = imports.ui.main;
const Meta = imports.gi.Meta;
const St = imports.gi.St;

// Fallbacks only - color/width are normally read live from the applet's
// own focusBorderColor/focusBorderWidth Settings, see applyStyle().
const FOCUS_BORDER_COLOR_DEFAULT = "#ff8800";
const FOCUS_BORDER_WIDTH_DEFAULT = 3;

// Window types a focused window actually looks like "a window" for border
// purposes - a right-click context menu becoming global.display.focus_window
// (confirmed live: Telegram's own context menu reports as OVERRIDE_OTHER
// while focused) shouldn't get outlined just because it briefly held focus,
// same for any other transient menu/tooltip/dnd-icon type. DIALOG/MODAL_DIALOG/
// UTILITY are kept since those are genuine windows a user works in (a "Save
// As" dialog, a tool palette), same as any other floating window.
const FOCUS_BORDER_WINDOW_TYPES = [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG, Meta.WindowType.UTILITY];

class FocusBorder {
    // applet: the owning KortileApplet - read for its settings-backed
    // properties (tilingEnabled, focusBorderEnabled, focusBorderColor,
    // focusBorderWidth, focusBorderHideMaximized, windowTabsSide) and a
    // handful of its own tracking state (_pendingTrack, _managerFor(),
    // _windowTabGroups) that decide whether/where to show the border.
    constructor(applet) {
        this._applet = applet;
        this._win = null; // Meta.Window currently outlined, if any
        this._signalIds = []; // signal ids connected on _win for live repositioning, see update()
        this.actor = new St.Bin({ style_class: "kortile-focus-border", reactive: false });
        Main.uiGroup.add_actor(this.actor);
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
        Main.uiGroup.set_child_above_sibling(this.actor, global.window_group);
        this.actor.hide();
    }

    applyStyle() {
        const a = this._applet;
        const color = a.focusBorderColor || FOCUS_BORDER_COLOR_DEFAULT;
        const width = Math.max(1, a.focusBorderWidth || FOCUS_BORDER_WIDTH_DEFAULT);
        this.actor.style = `border: ${width}px solid ${color}; border-radius: 2px;`;
    }

    // Tiling off (menu/keybinding/Settings) already untracks every window
    // and hides the border once, via the applet's own _untrackAll -
    // hide() - but nothing here stopped it coming right back: this method
    // has no idea tiling is off, so the very next focus change (clicking
    // any window at all) ran straight through to showing it again, on a
    // window kortile isn't even touching anymore. The border's own purpose
    // (telling tiled windows apart, several of which have no WM-drawn
    // border of their own) doesn't apply to anything once tiling itself is
    // off.
    update() {
        const a = this._applet;
        if (!a.tilingEnabled || !a.focusBorderEnabled) {
            this.hide();
            return;
        }

        const win = global.display.focus_window;
        // A fullscreen window's frame *is* the screen, so a border around
        // it would just outline the screen edge - never useful.
        if (!win || win.minimized || win.is_fullscreen()) {
            this.hide();
            return;
        }
        if (!FOCUS_BORDER_WINDOW_TYPES.includes(win.get_window_type())) {
            this.hide();
            return;
        }
        // A brand-new window, not tracked yet (see applet.js's
        // _onWindowCreated) - showing the border now and possibly hiding it
        // again a moment later once tracking resolves is a real, visible
        // flash, not just a stale-until-corrected state. Wait for that to
        // resolve either way instead of guessing.
        if (a._pendingTrack.has(win)) {
            this.hide();
            return;
        }

        const activeWs = global.workspace_manager.get_active_workspace_index();
        const onActiveWorkspace = win.get_workspace() && win.get_workspace().index() === activeWs;
        if (!onActiveWorkspace) {
            this.hide();
            return;
        }

        // Same idea as fullscreen: in maximized layout every window fills
        // the whole work area, so its border is likewise just a screen-edge
        // outline - true of any window there, master or slave (that split
        // is arbitrary in maximized layout, just whichever order windows
        // were opened in, and carries no visual meaning), so this is
        // optionally skipped for all of them, not just the master.
        const mg = a._managerFor(win);
        if (mg && mg.layout === "maximized" && a.focusBorderHideMaximized) {
            this.hide();
            return;
        }

        if (win !== this._win) {
            this._disconnectWindow();
            this._win = win;
            // Keep the outline glued to this window between focus changes -
            // it can move/resize (drag, retile, workspace follow) without
            // ever losing and regaining focus in between.
            this._signalIds = [
                win.connect("position-changed", () => this.update()),
                win.connect("size-changed", () => this.update()),
                win.connect("unmanaged", () => this.hide()),
            ];
        }

        const r = win.get_frame_rect();
        const bw = Math.max(1, a.focusBorderWidth || FOCUS_BORDER_WIDTH_DEFAULT);
        // A tab strip reserves its own space directly above (or, with
        // windowTabsSide "bottom", below) any window sharing that slot
        // (see applet.js's _reserveWindowTabSpace) - the usual bw-px
        // outward outset on every side assumes an actual empty tile gap
        // there to grow into, which doesn't exist on whichever side the
        // strip occupies: confirmed live the border's own edge extended
        // straight into the strip's reserved area instead, visibly
        // overlapping it (worse the wider the configured border width).
        // Skip the outset specifically on that one side for a window
        // currently covered by a strip - the other three still border a
        // normal tile gap, unaffected.
        let topExtend = bw;
        let bottomExtend = bw;
        for (const entry of a._windowTabGroups.values()) {
            if (entry.buttons.has(win)) {
                if (a.windowTabsSide === "bottom") bottomExtend = 0;
                else topExtend = 0;
                break;
            }
        }
        this.actor.set_position(r.x - bw, r.y - topExtend);
        this.actor.set_size(r.width + 2 * bw, r.height + topExtend + bottomExtend);
        this.actor.show();
    }

    _disconnectWindow() {
        if (this._win) {
            for (const id of this._signalIds) {
                try {
                    this._win.disconnect(id);
                } catch (e) {
                    // window is already gone
                }
            }
        }
        this._signalIds = [];
        this._win = null;
    }

    hide() {
        this._disconnectWindow();
        this.actor.hide();
    }

    destroy() {
        this._disconnectWindow();
        this.actor.destroy();
    }
}

// CommonJS export for Cinnamon's GJS require(). FOCUS_BORDER_WINDOW_TYPES is
// also reused by applet.js's own window-tab eligibility check
// (_isWindowTabEligible) - same "looks like a real window, not chrome/
// tooltip/menu" allowlist applies to both.
if (typeof module !== "undefined") {
    module.exports = { FocusBorder, FOCUS_BORDER_WINDOW_TYPES };
}
