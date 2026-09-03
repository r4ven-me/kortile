// Standalone sanity checks for tabs.js, run with plain node (not part of
// the Cinnamon runtime, just a fast local check for the strip-positioning
// math) - same idea as manager.test.js.
const { computeWindowTabStripX } = require("./tabs");

let failures = 0;
function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        failures++;
        console.error(`FAIL: ${msg}: expected ${expected}, got ${actual}`);
    }
}

// left (also the default/unknown-value fallback)
assertEqual(computeWindowTabStripX(100, 300, 120, "left"), 100, "left anchors at rectX");
assertEqual(computeWindowTabStripX(100, 300, 120, undefined), 100, "unset position falls back to left");
assertEqual(computeWindowTabStripX(100, 300, 120, "bogus"), 100, "unknown position falls back to left");

// center
assertEqual(computeWindowTabStripX(100, 300, 120, "center"), 190, "center: rectX + (300-120)/2 = 100+90");
assertEqual(computeWindowTabStripX(0, 200, 199, "center"), 1, "center rounds the leftover half-pixel");
assertEqual(computeWindowTabStripX(0, 200, 200, "center"), 0, "center with content exactly filling the slot");

// right
assertEqual(computeWindowTabStripX(100, 300, 120, "right"), 280, "right: rectX + (300-120)");
assertEqual(computeWindowTabStripX(0, 200, 0, "right"), 200, "right with zero-width content sits at the far edge");

// overflow (more tabs than fit the slot) - center/right must not push the
// strip's start past rectX in either direction, see tabs.js's own comment.
assertEqual(computeWindowTabStripX(100, 300, 400, "center"), 100, "center degrades to left when content overflows the slot");
assertEqual(computeWindowTabStripX(100, 300, 400, "right"), 100, "right degrades to left when content overflows the slot");
assertEqual(computeWindowTabStripX(100, 300, 300, "right"), 100, "right with content exactly filling the slot (zero offset)");

if (failures > 0) {
    console.error(`${failures} failure(s)`);
    if (typeof process !== "undefined") process.exit(1);
} else {
    console.log("All tabs.js checks passed.");
}
