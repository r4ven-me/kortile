// Standalone sanity checks for manager.js, run with plain node (not part of
// the Cinnamon runtime, just a fast local check for the layout math).
const { Manager } = require("./manager");

let failures = 0;
function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        failures++;
        console.error(`FAIL: ${msg}: expected ${expected}, got ${actual}`);
    }
}

const area = { x: 0, y: 0, w: 1000, h: 800 };

// vertical-right: single master, 2 slaves
{
    const mg = new Manager(0, 0, "vertical-right", 3, 3);
    mg.addWindow("A"); // becomes master
    mg.addWindow("B"); // slave
    mg.addWindow("C"); // slave
    const geo = mg.compute(area, 10);
    const a = geo.get("A"), b = geo.get("B"), c = geo.get("C");
    assertEqual(a.x > b.x, true, "master should be right of slaves in vertical-right");
    assertEqual(b.x, c.x, "slaves stack at same x");
    assertEqual(c.y < b.y, true, "C (added last, prepended to front of stack) above B");
    assertEqual(a.w + b.w + 10, area.w - 20, "widths + gap should fill shrunk area");
}

// vertical-left: master on left
{
    const mg = new Manager(0, 0, "vertical-left", 3, 3);
    mg.addWindow("A");
    mg.addWindow("B");
    const geo = mg.compute(area, 10);
    assertEqual(geo.get("A").x < geo.get("B").x, true, "master should be left of slave in vertical-left");
}

// horizontal-top: master on top
{
    const mg = new Manager(0, 0, "horizontal-top", 3, 3);
    mg.addWindow("A");
    mg.addWindow("B");
    const geo = mg.compute(area, 10);
    assertEqual(geo.get("A").y < geo.get("B").y, true, "master should be above slave in horizontal-top");
}

// single window fills the whole area regardless of layout
{
    const mg = new Manager(0, 0, "vertical-right", 3, 3);
    mg.addWindow("A");
    const geo = mg.compute(area, 10);
    const a = geo.get("A");
    assertEqual(a.w, area.w - 20, "solo window width == shrunk area width");
    assertEqual(a.h, area.h - 20, "solo window height == shrunk area height");
}

// maximized: every window gets the full area
{
    const mg = new Manager(0, 0, "maximized", 3, 3);
    mg.addWindow("A");
    mg.addWindow("B");
    mg.addWindow("C");
    const geo = mg.compute(area, 10);
    for (const w of ["A", "B", "C"]) {
        assertEqual(geo.get(w).w, area.w - 20, `maximized ${w} width`);
        assertEqual(geo.get(w).h, area.h - 20, `maximized ${w} height`);
    }
}

// removeWindow: removing the master promotes the first slave
{
    const mg = new Manager(0, 0, "vertical-right", 3, 3);
    mg.addWindow("A"); // master
    mg.addWindow("B"); // slave
    mg.removeWindow("A");
    assertEqual(mg.masters[0], "B", "B should be promoted to master after A is removed");
    assertEqual(mg.slaves.length, 0, "slaves empty after promotion");
}

// increaseMaster / decreaseMaster
{
    const mg = new Manager(0, 0, "vertical-right", 3, 3);
    mg.addWindow("A");
    mg.addWindow("B");
    mg.addWindow("C"); // A master, B/C slaves
    mg.increaseMaster();
    assertEqual(mg.masters.length, 2, "increaseMaster should grow masters to 2");
    assertEqual(mg.slaves.length, 1, "increaseMaster should shrink slaves to 1");
    mg.decreaseMaster();
    assertEqual(mg.masters.length, 1, "decreaseMaster should shrink masters back to 1");
    assertEqual(mg.slaves.length, 2, "decreaseMaster should grow slaves back to 2");
}

// swap / makeMaster
{
    const mg = new Manager(0, 0, "vertical-right", 3, 3);
    mg.addWindow("A"); // master
    mg.addWindow("B"); // slave
    mg.makeMaster("B");
    assertEqual(mg.masters[0], "B", "makeMaster should put B in master slot");
    assertEqual(mg.slaves[0], "A", "makeMaster should demote A to slave slot");
}

// slavesMax: overflow slaves share visible slots round-robin
{
    const mg = new Manager(0, 0, "vertical-right", 3, 2);
    mg.addWindow("A"); // master
    mg.addWindow("B"); // slave slot 0
    mg.addWindow("C"); // slave slot 1
    mg.addWindow("D"); // slave slot 0 (shares with B)
    const geo = mg.compute(area, 10);
    assertEqual(mg.slaves.length, 3, "3 slaves tracked even though only 2 are visible");
    assertEqual(geo.get("B").x, geo.get("D").x, "overflow slave D shares slot with B");
    assertEqual(geo.get("B").y, geo.get("D").y, "overflow slave D shares slot with B");
    assertEqual(geo.get("B").y !== geo.get("C").y, true, "B/D slot is distinct from C's slot");
}

// increaseSlave / decreaseSlave
{
    const mg = new Manager(0, 0, "vertical-right", 3, 2);
    assertEqual(mg.slavesMax, 2, "starts at slavesLimit");
    mg.decreaseSlave();
    assertEqual(mg.slavesMax, 1, "decreaseSlave lowers the visible count");
    mg.decreaseSlave();
    assertEqual(mg.slavesMax, 1, "decreaseSlave floors at 1");
    mg.increaseSlave();
    mg.increaseSlave();
    assertEqual(mg.slavesMax, 2, "increaseSlave caps at slavesLimit");
}

// setProportion: direct set, clamped to [min, 1-min]
{
    const mg = new Manager(0, 0, "vertical-right", 3, 3);
    mg.setProportion(0.7, 0.1);
    assertEqual(mg.ratio, 0.7, "setProportion sets the exact ratio within bounds");
    mg.setProportion(0.95, 0.1);
    assertEqual(mg.ratio, 0.9, "setProportion clamps to 1-min");
    mg.setProportion(0.02, 0.1);
    assertEqual(mg.ratio, 0.1, "setProportion clamps to min");
}

// setStackProportion: resizes only the two stacked windows at that
// boundary, leaving the relative split among the rest untouched
{
    const mg = new Manager(0, 0, "vertical-right", 1, 3);
    mg.addWindow("A"); // master (mastersMax=1)
    mg.addWindow("B"); // slave stack position 0
    mg.addWindow("C"); // slave stack position 1 (prepended, so slaves = [C, B])
    mg.addWindow("D"); // slave stack position 2 (prepended, so slaves = [D, C, B])
    assertEqual(JSON.stringify(mg.slaves), JSON.stringify(["D", "C", "B"]), "slaves stack order (last-added first)");

    const before = mg.compute(area, 10);
    const cbRatioBefore = before.get("C").h / before.get("B").h;

    // Drag the boundary between D (index 0) and C (index 1): D grows,
    // eating into the pool C and B split *between themselves* - C:B stays
    // the same relative split even though both shrink in absolute terms.
    mg.setStackProportion("slave", 0, 0.6, 0.1);
    const after = mg.compute(area, 10);
    assertEqual(after.get("D").h > before.get("D").h, true, "D grows after its boundary ratio increases");
    assertEqual(after.get("C").h < before.get("C").h, true, "C shrinks (less pool left for C+B combined)");
    assertEqual(after.get("B").h < before.get("B").h, true, "B shrinks (less pool left for C+B combined)");
    const cbRatioAfter = after.get("C").h / after.get("B").h;
    assertEqual(Math.abs(cbRatioAfter - cbRatioBefore) < 0.01, true, "C:B relative split is untouched by D's boundary change");
    assertEqual(after.get("C").y, after.get("D").y + after.get("D").h + 10, "C still starts right after D + gap");
}

// addWindow/removeWindow reset stack ratios back to equal split
{
    const mg = new Manager(0, 0, "vertical-right", 1, 3);
    mg.addWindow("A");
    mg.addWindow("B");
    mg.addWindow("C");
    mg.setStackProportion("slave", 0, 0.8, 0.1);
    assertEqual(mg.slaveRatios.length > 0, true, "slaveRatios populated after a manual resize");
    mg.addWindow("D");
    assertEqual(mg.slaveRatios.length, 0, "adding a window resets slaveRatios to equal split");
    mg.setStackProportion("slave", 0, 0.8, 0.1);
    mg.removeWindow("D");
    assertEqual(mg.slaveRatios.length, 0, "removing a window resets slaveRatios to equal split");
}

// compute()'s third argument (groupKeyFn) - slaves sharing a group key
// round-robin into the *same* visible slot together, not scattered
// individually by array position (kortile's own applet.js passes wm_class
// as the key, so every window of one app shares one slot - see
// _windowGroupKey - but this file stays agnostic to what a "group" means).
{
    const mg = new Manager(0, 0, "vertical-right", 1, 3);
    mg.addWindow("master");
    mg.addWindow("vscode-1");
    mg.addWindow("vscode-2");
    mg.addWindow("terminal-1");
    mg.addWindow("vscode-3");
    mg.addWindow("terminal-2");
    const geo = mg.compute(area, 10, (w) => w.split("-")[0]);
    const vscodeRects = ["vscode-1", "vscode-2", "vscode-3"].map((w) => geo.get(w));
    const terminalRects = ["terminal-1", "terminal-2"].map((w) => geo.get(w));
    assertEqual(
        vscodeRects.every((r) => r.x === vscodeRects[0].x && r.y === vscodeRects[0].y),
        true,
        "all same-group (vscode) slaves land in the same slot"
    );
    assertEqual(
        terminalRects.every((r) => r.x === terminalRects[0].x && r.y === terminalRects[0].y),
        true,
        "all same-group (terminal) slaves land in the same slot"
    );
    assertEqual(
        vscodeRects[0].x !== terminalRects[0].x || vscodeRects[0].y !== terminalRects[0].y,
        true,
        "different groups land in different slots when enough visible slots exist"
    );
}

// swap() with a real groupKeyFn actually trades the two groups' *rendered*
// slots, not just their array positions - this is the regression the
// stable slaveSlotAssignment (see _assignSlaveSlots) introduced and this
// test catches: without swap() itself updating slaveSlotAssignment to
// match, a group's slot staying "sticky" by design (that's the whole
// point of the fix above) meant a drag-to-swap between two slave groups
// reordered the array correctly but the rendered rects never actually
// traded places - a swap drag looked like it did nothing at all.
{
    const mg = new Manager(0, 0, "vertical-right", 1, 3);
    const key = (w) => w.split("-")[0];
    mg.addWindow("master");
    mg.addWindow("vscode-1");
    mg.addWindow("terminal-1");

    const before = mg.compute(area, 10, key);
    const vscodeSlotBefore = before.get("vscode-1");
    const terminalSlotBefore = before.get("terminal-1");
    assertEqual(
        vscodeSlotBefore.y !== terminalSlotBefore.y,
        true,
        "sanity check: vscode and terminal start in different slots"
    );

    mg.swap("vscode-1", "terminal-1", key); // e.g. dragging vscode-1 onto terminal-1
    const after = mg.compute(area, 10, key);
    assertEqual(
        after.get("vscode-1").y === terminalSlotBefore.y && after.get("vscode-1").x === terminalSlotBefore.x,
        true,
        "vscode now renders where terminal used to be"
    );
    assertEqual(
        after.get("terminal-1").y === vscodeSlotBefore.y && after.get("terminal-1").x === vscodeSlotBefore.x,
        true,
        "terminal now renders where vscode used to be"
    );
}

// swap() carries a group's round-robin slot-mate along with it, not just
// the two groups actually being dragged - regression test for a real bug
// in the fix above: with 3 groups sharing 2 visible slots, app1 and app3
// round-robin-share one slot (app1 the intended drag target's slot-mate,
// app3 hidden underneath) while app2 has the other slot to itself.
// Dragging app1 onto app2 must move *both* app1 and app3 to app2's old
// slot, not leave app3 behind pinned to app1's old slot number - that
// left-behind case is exactly what a user sees as "the dragged window
// moves, but the window it was hiding drops into its old spot instead of
// the window it was actually dropped onto".
{
    const mg = new Manager(0, 0, "vertical-right", 1, 2);
    const key = (w) => w.split("-")[0];
    mg.addWindow("master");
    mg.addWindow("app1-a");
    mg.addWindow("app2-a");
    mg.addWindow("app3-a");

    const before = mg.compute(area, 10, key);
    assertEqual(
        before.get("app1-a").x === before.get("app3-a").x && before.get("app1-a").y === before.get("app3-a").y,
        true,
        "sanity check: app1 and app3 start out round-robin-sharing one slot"
    );
    const sharedSlotBefore = before.get("app1-a");
    const app2SlotBefore = before.get("app2-a");
    assertEqual(
        sharedSlotBefore.x !== app2SlotBefore.x || sharedSlotBefore.y !== app2SlotBefore.y,
        true,
        "sanity check: app2 has the other slot to itself"
    );

    mg.swap("app1-a", "app2-a", key); // dragging app1 onto app2
    const after = mg.compute(area, 10, key);
    assertEqual(
        after.get("app1-a").x === app2SlotBefore.x && after.get("app1-a").y === app2SlotBefore.y,
        true,
        "app1 moved to app2's old slot"
    );
    assertEqual(
        after.get("app3-a").x === app2SlotBefore.x && after.get("app3-a").y === app2SlotBefore.y,
        true,
        "app3 followed app1 to app2's old slot instead of staying behind"
    );
    assertEqual(
        after.get("app2-a").x === sharedSlotBefore.x && after.get("app2-a").y === sharedSlotBefore.y,
        true,
        "app2 alone now occupies app1/app3's old shared slot"
    );
}

// The number of visible slots follows the number of distinct *groups*,
// not the raw slave count or slavesMax on its own - confirmed live as a
// real bug: with slavesMax=3 but every slave grouping into a single
// bucket (5 windows of one app), the slave area used to still get carved
// into 3 equal slots regardless, leaving two of them permanently empty
// (no window ever assigned to them) and squeezing the one real group's
// shared tab strip into a third of the space it should have had.
{
    // Reference: a single slave with slavesMax=1 unambiguously gets the
    // *entire* slave area to itself - whatever rect that produces is what
    // a single *group* should also get, regardless of how high slavesMax
    // is set or how many windows happen to be in that one group.
    const reference = new Manager(0, 0, "vertical-right", 1, 1);
    reference.addWindow("master");
    reference.addWindow("solo-slave");
    const fullSlaveRect = reference.compute(area, 10).get("solo-slave");

    const mg = new Manager(0, 0, "vertical-right", 1, 3);
    mg.addWindow("master");
    mg.addWindow("app-1");
    mg.addWindow("app-2");
    mg.addWindow("app-3");
    mg.addWindow("app-4");
    mg.addWindow("app-5");
    const geo = mg.compute(area, 10, () => "same-group");
    const rects = ["app-1", "app-2", "app-3", "app-4", "app-5"].map((w) => geo.get(w));
    assertEqual(
        rects.every((r) => r.w === rects[0].w && r.h === rects[0].h && r.x === rects[0].x && r.y === rects[0].y),
        true,
        "one group, slavesMax=3: every window in it gets the exact same rect"
    );
    assertEqual(
        JSON.stringify(rects[0]) === JSON.stringify(fullSlaveRect),
        true,
        "single group fills the *entire* slave area (same rect a lone slavesMax=1 slave would get), not 1/slavesMax of it"
    );
}

// No groupKeyFn passed at all - unchanged from before this existed: pure
// per-window round-robin by array position, same as every other test
// above this one already assumes.
{
    const mg = new Manager(0, 0, "vertical-right", 1, 2);
    mg.addWindow("master");
    mg.addWindow("A");
    mg.addWindow("B");
    mg.addWindow("C"); // 3 slaves, 2 visible slots -> round-robins by position
    const geo = mg.compute(area, 10);
    assertEqual(
        geo.get("A").x === geo.get("C").x && geo.get("A").y === geo.get("C").y,
        true,
        "default (no groupKeyFn) still round-robins purely by array position"
    );
}

// Slot assignment for round-robin-shared slave groups is stable across
// compute() calls, not recomputed as plain "i % visible" every time - this
// is the fix for an unrelated group's window closing silently swapping two
// *other*, untouched groups' slots with each other. 3 groups, 2 visible
// slots: g2 and g0 round-robin-share slot 0 (g2 is drawn on top), g1 has
// slot 1 to itself.
{
    const mg = new Manager(0, 0, "vertical-right", 1, 2);
    const key = (w) => w.split("-")[0];
    mg.addWindow("master");
    mg.addWindow("g0-a"); // slaves = [g0-a]
    mg.addWindow("g1-a"); // slaves = [g1-a, g0-a]
    mg.addWindow("g2-a"); // slaves = [g2-a, g1-a, g0-a]

    const before = mg.compute(area, 10, key);
    const g1SlotBefore = before.get("g1-a");
    const g0SlotBefore = before.get("g0-a");
    assertEqual(
        before.get("g2-a").x === g0SlotBefore.x && before.get("g2-a").y === g0SlotBefore.y,
        true,
        "sanity check: g2 and g0 start out round-robin-sharing one slot"
    );
    assertEqual(
        g1SlotBefore.x !== g0SlotBefore.x || g1SlotBefore.y !== g0SlotBefore.y,
        true,
        "sanity check: g1 has the other slot to itself"
    );

    mg.removeWindow("g2-a"); // g2's only window closes - slaves = [g1-a, g0-a]
    const after = mg.compute(area, 10, key);
    assertEqual(
        after.get("g1-a").x === g1SlotBefore.x && after.get("g1-a").y === g1SlotBefore.y,
        true,
        "g1 stays in its own slot after an unrelated group (g2) closes"
    );
    assertEqual(
        after.get("g0-a").x === g0SlotBefore.x && after.get("g0-a").y === g0SlotBefore.y,
        true,
        "g0 stays in its own (shared) slot too, instead of swapping with g1"
    );
}

// swap() with no groupKeyFn (or default) is a plain 1-for-1 element swap,
// unchanged from before groups existed - confirmed against both a
// same-list (slave/slave) and a cross-list (master/slave) swap.
{
    const mg = new Manager(0, 0, "vertical-right", 1, 2);
    mg.addWindow("master");
    mg.addWindow("A");
    mg.addWindow("B"); // addWindow unshifts, so slaves start as ["B", "A"]
    mg.swap("A", "B");
    assertEqual(JSON.stringify(mg.slaves), JSON.stringify(["A", "B"]), "swap() with no groupKeyFn: plain positional swap within slaves");

    const mg2 = new Manager(0, 0, "vertical-right", 1, 2);
    mg2.addWindow("master"); // "master" is mg2.masters[0]
    mg2.addWindow("A");
    mg2.swap("A", "master");
    assertEqual(JSON.stringify(mg2.masters), JSON.stringify(["A"]), "swap() with no groupKeyFn: cross-list (master/slave) swap moves the slave in");
    assertEqual(JSON.stringify(mg2.slaves), JSON.stringify(["master"]), "swap() with no groupKeyFn: cross-list swap moves the old master out");
}

// swap() *with* a groupKeyFn trades whole slot-groups, not just the two
// named windows - confirmed live as a real bug: dragging one window of a
// multi-window group (several windows of the same app sharing one visible
// slot, see compute()'s groupKeyFn bucketing) onto another window only
// swapped that *one* window's own array position, leaving its groupmate
//(still keyed the same, so compute() still bucketed it into the vacated
// slot) stranded behind rather than following along - from the user's
// side, dropping window A onto window B didn't put B where A used to be,
// some other window that had been hiding behind A ended up there instead.
{
    const groupKeyFn = (w) => w.split("#")[0];
    const mg = new Manager(0, 0, "vertical-left", 1, 2);
    mg.addWindow("master");
    mg.addWindow("app-A#1");
    mg.addWindow("app-A#2"); // shares a slot with app-A#1 (slavesMax=2, 2 groups)
    mg.addWindow("app-B#1");

    mg.swap("app-A#1", "app-B#1", groupKeyFn);

    const geo = mg.compute(area, 0, groupKeyFn);
    const bRect = geo.get("app-B#1");
    const a1Rect = geo.get("app-A#1");
    const a2Rect = geo.get("app-A#2");
    assertEqual(
        a1Rect.x === a2Rect.x && a1Rect.y === a2Rect.y,
        true,
        "group-aware swap: A's whole group (both windows) still shares one slot after the swap"
    );
    assertEqual(
        bRect.x !== a1Rect.x || bRect.y !== a1Rect.y,
        true,
        "group-aware swap: B moved to a different slot than A's group, not left sharing it"
    );
    assertEqual(
        JSON.stringify(mg.slaves.slice().sort()),
        JSON.stringify(["app-A#1", "app-A#2", "app-B#1"].sort()),
        "group-aware swap: no window lost or duplicated"
    );
}

// Same swap, but with a *third*, unrelated group present - it must keep
// its own relative position, neither dragged along with either swapped
// group nor left in a different spot than before.
{
    const groupKeyFn = (w) => w.split("#")[0];
    const mg = new Manager(0, 0, "vertical-left", 1, 3);
    mg.addWindow("master");
    mg.addWindow("app-A#1");
    mg.addWindow("app-X#1"); // unrelated third group, sits between A and B
    mg.addWindow("app-B#1");

    mg.swap("app-A#1", "app-B#1", groupKeyFn);

    assertEqual(mg.slaves.includes("app-X#1"), true, "group-aware swap: an uninvolved third group's window is neither dropped nor duplicated");
    const geoBefore = new Manager(0, 0, "vertical-left", 1, 3);
    geoBefore.addWindow("master");
    geoBefore.addWindow("app-A#1");
    geoBefore.addWindow("app-X#1");
    geoBefore.addWindow("app-B#1");
    const xRectBefore = geoBefore.compute(area, 0, groupKeyFn).get("app-X#1");
    const xRectAfter = mg.compute(area, 0, groupKeyFn).get("app-X#1");
    assertEqual(
        JSON.stringify(xRectBefore) === JSON.stringify(xRectAfter),
        true,
        "group-aware swap: the uninvolved third group's own slot is unaffected by A/B swapping theirs"
    );
}

// Several masters (mastersMax > 1, via increaseMaster) all share the
// *entire* master area as one identical rect, the same way a maximized
// layout shares its one area between everyone - not split into stacked
// columns. A window-tabs strip is what makes more than one usable there
// (see applet.js _reserveWindowTabSpace bucketing by rect), matching the
// user's own request: "master should behave like maximized" once more
// than one window is master.
{
    const mg = new Manager(0, 0, "vertical-left", 3, 3);
    mg.addWindow("master-1");
    mg.addWindow("slave-1");
    mg.addWindow("slave-2");
    mg.increaseMaster(); // promotes the front slave to a second master
    assertEqual(mg.masters.length, 2, "increaseMaster grew the master list to 2");

    const geo = mg.compute(area, 10);
    const m1 = geo.get(mg.masters[0]);
    const m2 = geo.get(mg.masters[1]);
    assertEqual(JSON.stringify(m1), JSON.stringify(m2), "both masters share the exact same rect");

    const reference = new Manager(0, 0, "vertical-left", 1, 3);
    reference.addWindow("solo-master");
    reference.addWindow("slave-1");
    reference.addWindow("slave-2");
    const fullMasterRect = reference.compute(area, 10).get("solo-master");
    assertEqual(
        JSON.stringify(m1) === JSON.stringify(fullMasterRect),
        true,
        "two masters together get the *entire* master area (same rect a single master would get), not split into columns"
    );
}

// removeWindow: removing one of *several* masters (mastersMax > 1) must not
// promote a slave when another master is still left - only a group that
// drops to zero masters needs backfilling. Confirmed live this was wrong:
// minimizing one of two windows sharing the master slot pulled an unrelated
// slave into masters anyway, silently expanding it into the master's shared
// rect even though the other master already satisfied the group.
{
    const mg = new Manager(0, 0, "vertical-left", 3, 3);
    mg.addWindow("master-1");
    mg.addWindow("slave-1");
    mg.addWindow("slave-2");
    // addWindow unshifts, so slaves is [slave-2, slave-1] here (slave-2
    // added last, at the front); increaseMaster's own shift() promotes
    // whichever is at that front - slave-2 - leaving slave-1 as the sole
    // remaining slave.
    mg.increaseMaster();
    assertEqual(mg.masters.length, 2, "two masters before removal");
    const remainingMaster = mg.masters.find((w) => w !== "slave-2");

    mg.removeWindow("slave-2"); // remove one of the two masters, not the last one
    assertEqual(mg.masters.length, 1, "exactly one master left");
    assertEqual(mg.masters[0], remainingMaster, "the other master stays master, untouched");
    assertEqual(mg.slaves.length, 1, "slave-1 was never promoted - still the only slave");
    assertEqual(mg.slaves[0], "slave-1", "slave-1 unchanged");
}

// removeWindow still backfills correctly for the plain single-master case
// (mastersMax=1, the default) - the fix above only narrows *when* it
// backfills, it shouldn't stop it from happening at all once masters is
// genuinely empty.
{
    const mg = new Manager(0, 0, "vertical-right", 3, 3);
    mg.addWindow("A"); // master
    mg.addWindow("B"); // slave
    mg.removeWindow("A");
    assertEqual(mg.masters[0], "B", "B still promoted to master once masters is actually empty");
    assertEqual(mg.slaves.length, 0, "slaves empty after promotion");
}

// restoreWindow: a slave that temporarily left (minimized, native
// maximize/fullscreen, explicit float - see applet.js) comes back to its
// old slot instead of addWindow()'s own front-insert, leaving every other
// window's slot untouched - this is the fix for restoring a minimized
// window (e.g. via a taskbar/grouped-window-list click) visibly reshuffling
// the whole tiled layout instead of just reappearing where it was.
{
    const mg = new Manager(0, 0, "vertical-right", 3, 3);
    mg.addWindow("master"); // master
    mg.addWindow("A"); // slaves = [A]
    mg.addWindow("B"); // slaves = [B, A]
    mg.addWindow("C"); // slaves = [C, B, A]
    const info = mg.removeWindow("B"); // slaves = [C, A]
    assertEqual(info.kind, "slave", "B was removed from the slave list");
    assertEqual(info.index, 1, "B was at slave index 1 before removal");
    mg.restoreWindow("B", info);
    assertEqual(mg.slaves.join(","), "C,B,A", "B lands back at its old index, not the front");
}

// restoreWindow: same idea for a master that temporarily left.
{
    const mg = new Manager(0, 0, "vertical-right", 3, 3);
    mg.addWindow("A"); // master
    mg.addWindow("B"); // slaves = [B]
    mg.addWindow("C"); // slaves = [C, B]
    mg.increaseMaster(); // needs 2+ slaves to promote one - masters = [A, C], slaves = [B]
    assertEqual(mg.masters.join(","), "A,C", "sanity check on increaseMaster's own result");
    const info = mg.removeWindow("C"); // masters = [A]
    assertEqual(info.kind, "master", "C was removed from the master list");
    assertEqual(info.index, 1, "C was at master index 1 before removal");
    mg.restoreWindow("C", info);
    assertEqual(mg.masters.join(","), "A,C", "C lands back in the master list, at its old index");
}

// restoreWindow: falls back to addWindow()'s front-insert when there's
// nothing to restore (no info at all) - still the right call for a
// genuinely new window, which never has a prior removeWindow() to point
// back to.
{
    const mg = new Manager(0, 0, "vertical-right", 3, 3);
    mg.addWindow("A"); // master
    mg.addWindow("B"); // slaves = [B]
    mg.restoreWindow("C", null);
    assertEqual(mg.slaves.join(","), "C,B", "no info falls back to a plain front-insert");
}

// restoreWindow: also falls back to a front-insert when the remembered
// slot no longer fits - e.g. mastersMax shrank back to 1 while a second
// master was away, so its old master slot isn't available to return to.
{
    const mg = new Manager(0, 0, "vertical-right", 3, 3);
    mg.addWindow("A"); // master
    mg.addWindow("B"); // slaves = [B]
    mg.addWindow("C"); // slaves = [C, B]
    mg.increaseMaster(); // masters = [A, C], slaves = [B]
    const info = mg.removeWindow("C"); // masters = [A]
    mg.mastersMax = 1; // simulate the limit shrinking while C was away
    mg.restoreWindow("C", info);
    assertEqual(mg.masters.join(","), "A", "master slot no longer fits, so C did not rejoin masters");
    assertEqual(mg.slaves.join(","), "C,B", "C fell back into the slave list instead");
}

if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
}
console.log("All manager.js checks passed");
