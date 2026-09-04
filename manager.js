// Master-slave tiling state and geometry math for a single (workspace, monitor)
// pair. Deliberately has no Cinnamon/Meta dependency so it stays easy to reason
// about: it only deals with plain window handles and {x,y,w,h} rectangles.

var LAYOUTS = ["vertical-left", "vertical-right", "horizontal-top", "horizontal-bottom", "maximized"];

function splitRectInTwo(rect, ratio, gap, axis) {
    if (axis === "x") {
        const total = Math.max(rect.w - gap, 0);
        const wa = Math.round(total * ratio);
        const wb = total - wa;
        return [
            { x: rect.x, y: rect.y, w: wa, h: rect.h },
            { x: rect.x + wa + gap, y: rect.y, w: wb, h: rect.h },
        ];
    }
    const total = Math.max(rect.h - gap, 0);
    const ha = Math.round(total * ratio);
    const hb = total - ha;
    return [
        { x: rect.x, y: rect.y, w: rect.w, h: ha },
        { x: rect.x, y: rect.y + ha + gap, w: rect.w, h: hb },
    ];
}

// Splits rect into n slices stacked along axis ("x" = side by side, "y" =
// top to bottom), one boundary at a time: ratios[i] is what share of the
// space *remaining from item i onward* item i itself takes, so ratios[0]
// splits (item 0 : everything after it), ratios[1] then splits (item 1 :
// everything after *that*), and so on - the same nested-split idea
// splitRectInTwo already uses for the master/slave divide, just chained.
// Missing/undefined entries in ratios default to an equal share of
// whatever's left at that point, which reduces to a plain equal split when
// ratios is empty - dragging the boundary between two adjacent stacked
// items (see applet.js _updateStackProportionFromResize) only ever needs
// to change the one ratio at that boundary, leaving every other item's
// relative sizing untouched.
function splitStackWeighted(rect, n, gap, axis, ratios) {
    if (n <= 0) return [];
    if (n === 1) return [rect];
    const rects = [];
    let remaining = rect;
    for (let i = 0; i < n - 1; i++) {
        const itemsLeft = n - i;
        const ratio = ratios && ratios[i] !== undefined ? ratios[i] : 1 / itemsLeft;
        const [a, b] = splitRectInTwo(remaining, ratio, gap, axis);
        rects.push(a);
        remaining = b;
    }
    rects.push(remaining);
    return rects;
}

function shrink(rect, gap) {
    return { x: rect.x + gap, y: rect.y + gap, w: Math.max(rect.w - 2 * gap, 0), h: Math.max(rect.h - 2 * gap, 0) };
}

class Manager {
    // When there are more slaves than slavesMax, extras double up on the
    // visible slots (round-robin by index) rather than getting their own
    // sliver. An earlier version of this mechanic reacted to *every*
    // incidental geometry echo as a potential swap; that's fixed at the
    // source now (swaps only commit once a real mouse-grab ends), so
    // sharing slots no longer reintroduces it.
    constructor(workspaceIndex, monitorIndex, layout, mastersLimit, slavesLimit) {
        this.workspaceIndex = workspaceIndex;
        this.monitorIndex = monitorIndex;
        this.layout = layout;
        this.mastersMax = 1;
        this.mastersLimit = mastersLimit;
        this.slavesMax = slavesLimit;
        this.slavesLimit = slavesLimit;
        this.ratio = 0.5;
        this.masters = [];
        this.slaves = [];
        this.masterRatios = []; // per-boundary split within the master stack, see setStackProportion
        this.slaveRatios = []; // per-boundary split within the (visible) slave stack
        // groupKey -> slot index (0-based, see compute()'s own slaveArea
        // handling) - which physical visible slot a slave *group* currently
        // occupies, persisted across compute() calls so an unrelated
        // group's membership changing elsewhere doesn't reshuffle everyone
        // else's slot. See _assignSlaveSlots.
        this.slaveSlotAssignment = new Map();
    }

    hasWindow(win) {
        return this.masters.indexOf(win) >= 0 || this.slaves.indexOf(win) >= 0;
    }

    addWindow(win) {
        if (this.hasWindow(win)) return;
        if (this.masters.length < this.mastersMax) {
            this.masters.unshift(win);
            this.masterRatios = [];
        } else {
            this.slaves.unshift(win);
            this.slaveRatios = [];
        }
    }

    // Returns where win was removed from ({kind: "master"|"slave", index}),
    // or null if it wasn't tracked at all - callers that only mean to
    // *temporarily* pull a window out (minimizing, native maximize/
    // fullscreen, explicit float, see applet.js) pass this straight back
    // into restoreWindow() so putting it back doesn't reshuffle every other
    // window's slot the way addWindow()'s own front-insert would (see
    // restoreWindow() below).
    removeWindow(win) {
        let i = this.masters.indexOf(win);
        if (i >= 0) {
            this.masters.splice(i, 1);
            this.masterRatios = [];
            // Only backfill from slaves when that leaves *no* master at all -
            // with mastersMax > 1 (several masters sharing one rect, see
            // compute()), removing just one of several still leaves the
            // group with a master, so there's nothing to backfill. Confirmed
            // live this was wrong before: minimizing one of two windows
            // sharing the master slot (mastersMax=2) promoted an unrelated
            // slave into masters anyway, even though the other master was
            // still right there - the promoted slave then shared the whole
            // master rect with it (masters "share one rect", see compute()),
            // silently expanding into space that wasn't its own. Restoring
            // the minimized window afterward never undid that: addWindow()
            // just appends another master on top of the now-permanently
            // wrong split.
            if (this.masters.length === 0 && this.slaves.length > 0) {
                this.masters.push(this.slaves.shift());
                this.slaveRatios = [];
            }
            return { kind: "master", index: i };
        }
        i = this.slaves.indexOf(win);
        if (i >= 0) {
            this.slaves.splice(i, 1);
            this.slaveRatios = [];
            return { kind: "slave", index: i };
        }
        return null;
    }

    // Re-inserts win at (approximately) the position a prior removeWindow()
    // reported it was removed from, instead of addWindow()'s own front-
    // insert - used when a window that only *temporarily* left (minimized,
    // native-maximized/fullscreened, explicitly floated) comes back, so it
    // lands back near its old slot rather than jumping to the front and
    // shifting every other window's slot along with it. info is whatever
    // the matching removeWindow() call returned; falls back to addWindow()'s
    // plain front-insert (still the right call for a genuinely new window)
    // when there's nothing usable to restore - no info, or its remembered
    // slot no longer fits (e.g. mastersMax shrunk while it was away).
    restoreWindow(win, info) {
        if (this.hasWindow(win)) return;
        if (info && info.kind === "master" && this.masters.length < this.mastersMax) {
            const i = Math.max(0, Math.min(info.index, this.masters.length));
            this.masters.splice(i, 0, win);
            this.masterRatios = [];
            return;
        }
        if (info && info.kind === "slave") {
            const i = Math.max(0, Math.min(info.index, this.slaves.length));
            this.slaves.splice(i, 0, win);
            this.slaveRatios = [];
            return;
        }
        this.addWindow(win);
    }

    allWindows() {
        return this.masters.concat(this.slaves);
    }

    // groupKeyFn defaults to a unique key per window (see compute()), so a
    // plain swap(w1, w2) with no third argument keeps its old exact
    // meaning: trade w1 and w2's own two array positions, nothing else.
    //
    // Passed the *real* groupKeyFn (see applet.js's _windowGroupKey), this
    // instead trades w1's whole *slot group* with w2's - every window that
    // currently buckets into the same slot as w1 (see compute()'s grouping)
    // moves together as one block, and likewise for w2. Confirmed live (and
    // in manager.test.js) that swapping by raw array position alone breaks
    // down the moment either window shares its slot with another one of
    // the same app: dragging window A onto window B only swapped *A's own*
    // array slot with B's, but A's groupmate (still keyed the same, still
    // bucketed into A's old slot by compute()) silently came along for the
    // ride instead of staying behind - from the user's side, dropping A
    // onto B didn't put B where A used to be, it looked like some
    // unrelated window that had been hiding behind A took that spot
    // instead, seemingly at random depending on which of A's groupmates
    // compute() happened to bucket first.
    swap(w1, w2, groupKeyFn = (win, index) => index) {
        const lists = [this.masters, this.slaves];
        let l1 = null, l2 = null;
        for (const l of lists) {
            if (l.indexOf(w1) >= 0) l1 = l;
            if (l.indexOf(w2) >= 0) l2 = l;
        }
        if (!l1 || !l2) return;

        if (l1 !== l2) {
            // Master <-> slave swap: the master list only ever holds
            // mastersMax windows and (being the master slot) never shares
            // one slot between several windows the way slaves can, so
            // there's no "other group member" that could get left behind
            // or dragged along here - a plain single-element swap already
            // does the right thing.
            const i1 = l1.indexOf(w1);
            const i2 = l2.indexOf(w2);
            const tmp = l1[i1];
            l1[i1] = l2[i2];
            l2[i2] = tmp;
            return;
        }

        const list = l1;
        const key1 = groupKeyFn(w1, list.indexOf(w1));
        const key2 = groupKeyFn(w2, list.indexOf(w2));
        if (key1 === key2) return; // already sharing one slot - nothing to trade

        // Collapse the list down to: every *other* group's windows, kept
        // in their original relative order, plus one marker each at w1's
        // group's and w2's group's first occurrence (compute() only cares
        // about a group's *first* occurrence to decide its slot order, so
        // later members of the same group carry no separate position of
        // their own here). Expanding marker1 back out to w2's full window
        // list (and marker2 to w1's) is what actually swaps the two
        // groups' slots - whichever group has more windows than the other
        // just carries them all along together, still as one block.
        const group1 = [], group2 = [];
        const rest = [];
        let sawGroup1 = false, sawGroup2 = false;
        list.forEach((w, i) => {
            const k = groupKeyFn(w, i);
            if (k === key1) {
                group1.push(w);
                if (!sawGroup1) { rest.push({ marker: 1 }); sawGroup1 = true; }
            } else if (k === key2) {
                group2.push(w);
                if (!sawGroup2) { rest.push({ marker: 2 }); sawGroup2 = true; }
            } else {
                rest.push({ w });
            }
        });

        const result = [];
        for (const item of rest) {
            if (item.marker === 1) result.push(...group2);
            else if (item.marker === 2) result.push(...group1);
            else result.push(item.w);
        }
        list.length = 0;
        list.push(...result);

        // Trade key1's and key2's *rendered* slot along with their array
        // block, same as compute() would have derived directly from the
        // reordered array before slaveSlotAssignment existed (see
        // _assignSlaveSlots) - without this, a drag-to-swap between two
        // slave groups reordered the array correctly but visibly did
        // nothing: _assignSlaveSlots keeps a group's existing slot
        // untouched by default (that's the whole point of it - an
        // unrelated group closing elsewhere shouldn't reshuffle anyone
        // else), and neither key1 nor key2 ever left the manager for that
        // cleanup to kick in on its own, so both groups kept rendering in
        // their pre-swap slots forever, no matter how many times the user
        // dragged one onto the other.
        if (list === this.slaves) {
            const slot1 = this.slaveSlotAssignment.get(key1);
            const slot2 = this.slaveSlotAssignment.get(key2);
            if (slot2 !== undefined) this.slaveSlotAssignment.set(key1, slot2);
            else this.slaveSlotAssignment.delete(key1);
            if (slot1 !== undefined) this.slaveSlotAssignment.set(key2, slot1);
            else this.slaveSlotAssignment.delete(key2);
        }
    }

    makeMaster(win) {
        if (this.masters.length === 0) return;
        this.swap(win, this.masters[0]);
    }

    nextWindow(win) {
        const all = this.allWindows();
        const i = all.indexOf(win);
        if (i < 0 || all.length === 0) return null;
        return all[(i + 1) % all.length];
    }

    previousWindow(win) {
        const all = this.allWindows();
        const i = all.indexOf(win);
        if (i < 0 || all.length === 0) return null;
        return all[(i - 1 + all.length) % all.length];
    }

    increaseMaster() {
        if (this.slaves.length > 1 && this.mastersMax < this.mastersLimit) {
            this.mastersMax += 1;
            this.masters.push(this.slaves.shift());
            this.masterRatios = [];
            this.slaveRatios = [];
        }
    }

    decreaseMaster() {
        if (this.masters.length > 1) {
            this.mastersMax -= 1;
            this.slaves.unshift(this.masters.pop());
            this.masterRatios = [];
            this.slaveRatios = [];
        }
    }

    increaseSlave() {
        if (this.slavesMax < this.slavesLimit) {
            this.slavesMax += 1;
            this.slaveRatios = [];
        }
    }

    decreaseSlave() {
        if (this.slavesMax > 1) {
            this.slavesMax -= 1;
            this.slaveRatios = [];
        }
    }

    increaseProportion(step, min = 0.1) {
        this.ratio = Math.min(this.ratio + step, 1 - min);
    }

    decreaseProportion(step, min = 0.1) {
        this.ratio = Math.max(this.ratio - step, min);
    }

    // Sets the master-slave ratio directly (clamped), as opposed to
    // stepping it - used when a manual window resize drag is translated
    // into a proportion change instead of being fought/snapped back.
    setProportion(ratio, min = 0.1) {
        this.ratio = Math.max(min, Math.min(ratio, 1 - min));
    }

    // Sets the split ratio at one boundary within the master or slave
    // stack directly (clamped) - kind is "master" or "slave", index is
    // which boundary (0 = between stack position 0 and the rest), matching
    // splitStackWeighted's scheme. Used the same way setProportion is: a
    // manual resize drag on a boundary *between two stacked windows*
    // (rather than the master/slave divide) becomes a proportion change
    // there instead of being fought/snapped back.
    setStackProportion(kind, index, ratio, min = 0.1) {
        const ratios = kind === "master" ? this.masterRatios : this.slaveRatios;
        ratios[index] = Math.max(min, Math.min(ratio, 1 - min));
    }

    reset(defaultMastersMax, defaultRatio) {
        this.mastersMax = defaultMastersMax;
        this.slavesMax = this.slavesLimit;
        this.ratio = defaultRatio;
        this.masterRatios = [];
        this.slaveRatios = [];
        this.slaveSlotAssignment = new Map();
    }

    // Returns a Map<win, {x,y,w,h}> for every tracked window.
    //
    // groupKeyFn(win, index) decides which slave windows round-robin into
    // the *same* visible slot together, rather than purely by array
    // position - defaults to a unique key per index, i.e. one window per
    // group, reproducing the old plain round-robin exactly (also what
    // keeps this backwards compatible with callers, including
    // manager.test.js, that don't pass a third argument at all). The
    // caller decides what a "group" actually means - this file stays
    // agnostic to anything Meta/GJS-specific (wm_class, in kortile's own
    // case - see applet.js) so it's still just as testable standalone
    // with plain string/number stand-ins for windows.
    compute(workArea, gap, groupKeyFn = (win, index) => index) {
        const result = new Map();
        const area = shrink(workArea, gap);
        const m = this.masters, s = this.slaves;
        const all = m.concat(s);
        if (all.length === 0) return result;

        if (this.layout === "maximized" || all.length === 1) {
            for (const w of all) result.set(w, area);
            return result;
        }

        const vertical = this.layout.startsWith("vertical");
        const splitAxis = vertical ? "x" : "y";
        const stackAxis = vertical ? "y" : "x";
        const masterFirst = this.layout === "vertical-left" || this.layout === "horizontal-top";

        let masterArea = area, slaveArea = null;
        if (s.length > 0) {
            const [ra, rb] = splitRectInTwo(area, this.ratio, gap, splitAxis);
            masterArea = masterFirst ? ra : rb;
            slaveArea = masterFirst ? rb : ra;
        }

        // Every master shares the *entire* master area (one rect object,
        // same as the maximized/single-window case above) rather than each
        // getting its own stacked column - mastersMax caps how many
        // windows can be master at all, not how many columns to split the
        // area into. A window-tabs strip (see applet.js
        // _reserveWindowTabSpace) is what actually lets more than one be
        // usable there: it buckets by rect, so several masters sharing
        // this identical object are picked up as one group automatically,
        // the exact same way a maximized layout's single shared area is.
        for (const w of m) result.set(w, masterArea);
        if (slaveArea) {
            // Bucket slaves by groupKeyFn *first* - every window in a
            // bucket shares whichever slot that bucket ends up on, rather
            // than each window separately claiming slots[i % visible] by
            // its own raw position. With the default one-per-index key
            // every bucket has exactly one window in it, so this reduces
            // to the exact same assignment the old plain round-robin
            // produced.
            const groupOrder = [];
            const byGroup = new Map();
            s.forEach((w, i) => {
                const key = groupKeyFn(w, i);
                if (!byGroup.has(key)) {
                    byGroup.set(key, []);
                    groupOrder.push(key);
                }
                byGroup.get(key).push(w);
            });
            // The number of visible *slots* has to follow the number of
            // groups that actually exist, not the raw window count -
            // confirmed live this was a real bug: with slavesMax higher
            // than the number of distinct groups (e.g. 5 windows of one
            // app, grouped into a single bucket, but slavesMax still 3),
            // slots was still built for 3, splitting the slave area into
            // three equal-height slots - one got the whole group's shared
            // tab strip, squeezed into a third of the height, and the
            // other two sat there empty (no window ever assigned to them
            // at all), showing bare desktop where a tiled window should
            // have been. Capping by the *group* count instead means a
            // slavesMax higher than however many distinct groups exist
            // just gives each of them the full slave area to itself.
            const visible = Math.max(1, Math.min(groupOrder.length, this.slavesMax));
            const slots = splitStackWeighted(slaveArea, visible, gap, stackAxis, this.slaveRatios);
            const slotForGroup = this._assignSlaveSlots(groupOrder, visible);
            groupOrder.forEach((key) => {
                const slot = slots[slotForGroup.get(key)];
                for (const w of byGroup.get(key)) result.set(w, slot);
            });
        }
        return result;
    }

    // Which physical slot (0-based index into compute()'s own `slots`
    // array) each of this round's slave groups occupies - persisted in
    // this.slaveSlotAssignment across calls instead of recomputed as plain
    // `i % visible` every time, which is what compute() used to do
    // directly. That plain modulo looked stateless but wasn't really: i is
    // each group's position within *this call's* groupOrder, which shifts
    // for every group after one that gained or lost its last window (an
    // earlier group's window closing, say) even though nothing about the
    // later groups themselves changed - the visible symptom was two
    // *unrelated* groups (an app closing had nothing to do with either)
    // trading slots with each other, purely because their index parity
    // relative to slavesMax happened to flip. A group that already holds a
    // still-valid slot (< visible) keeps it here regardless of what
    // happens elsewhere; only a group with no assignment yet - brand new,
    // or its old slot number no longer exists because slavesMax/the
    // group count shrank - claims the currently least-occupied slot,
    // lowest index first on a tie (reduces to the same left-to-right fill
    // plain round-robin already produced for a fresh manager with no prior
    // assignment, which is what every existing compute() test exercises).
    _assignSlaveSlots(groupOrder, visible) {
        const current = new Set(groupOrder);
        const assignment = this.slaveSlotAssignment;
        for (const key of assignment.keys()) {
            if (!current.has(key)) assignment.delete(key);
        }
        const occupancy = new Array(visible).fill(0);
        for (const [key, slot] of assignment) {
            if (slot < visible) {
                occupancy[slot]++;
            } else {
                assignment.delete(key); // that slot no longer exists - needs a fresh one below
            }
        }
        for (const key of groupOrder) {
            if (assignment.has(key)) continue;
            let best = 0;
            for (let i = 1; i < visible; i++) {
                if (occupancy[i] < occupancy[best]) best = i;
            }
            assignment.set(key, best);
            occupancy[best]++;
        }
        return assignment;
    }
}

// CommonJS export for Cinnamon's GJS require(), plus a plain global fallback
// so this file can also be loaded/tested standalone with a normal gjs/node run.
if (typeof module !== "undefined") {
    module.exports = { Manager, LAYOUTS, splitRectInTwo, splitStackWeighted, shrink };
}
