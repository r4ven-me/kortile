// Pure, Cinnamon/GJS-free helpers for the window-tabs feature (see
// applet.js's _syncWindowTabStrips etc.) - split out for the same reason as
// manager.js: applet.js itself can't be `require()`-d from plain node (it
// hits `imports.ui.applet` etc. at load time, which only exist inside the
// Cinnamon runtime), so anything meant to be unit-tested standalone (see
// tabs.test.js) has to live somewhere with no such dependency.

// Where a window-tab strip's left edge lands within its slot, per the
// window-tabs-position setting ("left"/"center"/"right").
//
// maxOffset is clamped to >= 0: when the strip's natural content width is
// already >= the slot width (more tabs than comfortably fit), center/right
// both degrade to flush-left rather than starting the strip left of rectX
// (center, if allowed to go negative) or pushing it further right of an
// already-overflowing edge (right, which would otherwise still hug the far
// right and overflow *both* edges instead of just one).
function computeWindowTabStripX(rectX, rectW, contentW, position) {
    const maxOffset = Math.max(0, rectW - contentW);
    switch (position) {
        case "center":
            return rectX + Math.round(maxOffset / 2);
        case "right":
            return rectX + maxOffset;
        default:
            return rectX;
    }
}

// CommonJS export for Cinnamon's GJS require(), plus a plain global fallback
// so this file can also be loaded/tested standalone with a normal gjs/node run.
if (typeof module !== "undefined") {
    module.exports = { computeWindowTabStripX };
}
