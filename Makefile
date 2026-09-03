.DEFAULT_GOAL := help

UUID             := kortile@r4ven.me
# Read straight out of metadata.json rather than duplicated by hand here -
# used as release's own default commit message (see below) when MSG isn't
# given, so it can't silently drift out of sync with the actual version.
VERSION          := $(shell grep -m1 '"version"' metadata.json | sed -E 's/.*"version": *"([^"]+)".*/\1/')
FORK_REMOTE      := git@github.com:r4ven-me/cinnamon-spices-applets.git
# Read-only (HTTPS, no auth needed for a public repo) - this is linuxmint's
# own repo, not your fork, so nothing here ever pushes to it.
UPSTREAM_REMOTE  := https://github.com/linuxmint/cinnamon-spices-applets.git
FORK_DIR         := .spice-fork
SPICE_DIR     := $(FORK_DIR)/$(UUID)
FILES_DIR     := $(SPICE_DIR)/files/$(UUID)

APPLET_FILES  := applet.js manager.js manager.test.js tabs.js tabs.test.js \
                 metadata.json settings-schema.json icon_dark.svg icon_light.svg

.PHONY: help release test spice-clone spice-sync spice-validate spice-diff spice-update spice-commit spice-push spice-publish spice-sync-upstream spice-status spice-clean

help:
	@echo "  make test               run manager.test.js + tabs.test.js"
	@echo "  make release            the everything button: test, commit + push"
	@echo "                          THIS repo, clone the fork if it isn't yet,"
	@echo "                          sync it with upstream, then sync/validate/"
	@echo "                          commit/push this applet's own change into"
	@echo "                          it too - stops at the first failure"
	@echo "                          make release MSG=\"describe what changed\""
	@echo "                          MSG optional - defaults to \"Release v$(VERSION)\""
	@echo ""
	@echo "Targets for syncing this repo with linuxmint/cinnamon-spices-applets:"
	@echo "  make spice-clone        clone your fork into $(FORK_DIR)/ (once)"
	@echo "  make spice-sync         copy this repo's code + spice/ metadata into the clone"
	@echo "  make spice-validate     run the fork's own validate-spice check"
	@echo "  make spice-diff         show what changed in the clone since last commit"
	@echo "  make spice-update       sync + validate (safe, no git action)"
	@echo "  make spice-commit       commit the synced change in the clone"
	@echo "  make spice-push         push the clone's current branch"
	@echo "  make spice-publish      sync + validate + commit + push, one command"
	@echo "                          make spice-publish MSG=\"describe what changed\""
	@echo "  make spice-sync-upstream  pull linuxmint's real repo into your fork"
	@echo "                            ($(FORK_DIR) never does this on its own -"
	@echo "                            it's a snapshot from clone time, and even"
	@echo "                            your GitHub fork itself doesn't auto-track"
	@echo "                            upstream; run this occasionally, e.g."
	@echo "                            before starting a new change)"
	@echo "  make spice-status       where things stand (cloned? synced? dirty?)"
	@echo "  make spice-clean        remove $(FORK_DIR)/ entirely (re-clone next time)"
	@echo ""
	@echo "First time: fork https://github.com/linuxmint/cinnamon-spices-applets"
	@echo "on GitHub yourself first (needs your account) - FORK_REMOTE above assumes"
	@echo "it's named r4ven-me/cinnamon-spices-applets; override if not:"
	@echo "  make spice-clone FORK_REMOTE=git@github.com:you/cinnamon-spices-applets.git"

# --- this repo itself --------------------------------------------------------

# manager.js/tabs.js are deliberately Meta/Clutter-free (see their own
# comments) specifically so they can be checked with plain node, no running
# Cinnamon needed - the one part of this codebase release can actually
# verify before pushing anything anywhere.
test:
	node manager.test.js
	node tabs.test.js

# Publishes a change end to end, the one command that does all of it: run
# the test suite first (bails out before touching git at all if something's
# broken); commit + push this repo (the real source of truth); make sure
# the cinnamon-spices-applets fork is even cloned yet (spice-clone is a
# no-op if it already is); merge linuxmint's own upstream into it
# (spice-sync-upstream) so it's never stale before publishing on top of it;
# then sync/validate/commit/push this applet's own change into that fork
# (spice-publish). Stops at the first failure anywhere in that chain rather
# than pushing a half-finished result - each step still runs standalone on
# its own above if you want to inspect or redo just one of them. MSG is
# optional here (unlike spice-commit/spice-publish on their own, which
# still require one) - falls back to "Release vX.Y.Z" straight from
# metadata.json's own version when not given.
#
# Commit and push are two separate checks on purpose - confirmed live
# `git status --porcelain` alone (only uncommitted working-tree changes)
# silently skipped the push entirely whenever the tree was already clean,
# even with real local commits sitting unpushed (no upstream configured at
# all counts as exactly that, same as a normal branch that's just ahead).
release: test
	@if [ -n "$$(git status --porcelain)" ]; then \
		git add -A && git commit -m "$(if $(MSG),$(MSG),Release v$(VERSION))"; \
	else \
		echo "Nothing uncommitted in this repo."; \
	fi
	@if ! git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then \
		echo "No upstream tracking yet for this branch - pushing and setting it."; \
		git push -u origin HEAD; \
	elif [ -n "$$(git log @{u}..HEAD --oneline)" ]; then \
		git push; \
	else \
		echo "Nothing to push - this repo is already up to date with the remote."; \
	fi
	@if [ ! -d "$(FORK_DIR)/.git" ]; then $(MAKE) spice-clone; fi
	$(MAKE) spice-sync-upstream
	$(MAKE) spice-publish MSG="$(if $(MSG),$(MSG),Release v$(VERSION))"

# --- one-time setup ---------------------------------------------------------

spice-clone:
	@if [ -d "$(FORK_DIR)/.git" ]; then \
		echo "$(FORK_DIR) already exists - use 'make spice-clean' first to re-clone."; \
	else \
		git clone "$(FORK_REMOTE)" "$(FORK_DIR)"; \
	fi

# --- day to day --------------------------------------------------------------

spice-sync: _require-clone
	@mkdir -p "$(FILES_DIR)"
	@for f in $(APPLET_FILES); do cp "$$f" "$(FILES_DIR)/"; done
	@cp spice/icon.png "$(FILES_DIR)/icon.png"
	@cp spice/info.json "$(SPICE_DIR)/info.json"
	@cp spice/README.md "$(SPICE_DIR)/README.md"
	@cp spice/screenshot.png "$(SPICE_DIR)/screenshot.png"
	@echo "Synced into $(SPICE_DIR)"
	@echo "Note: files/ must contain ONLY the $(UUID) folder - if the fork's"
	@echo "layout ever changes upstream, check that by hand."

spice-validate: _require-clone
	@cd "$(FORK_DIR)" && ./validate-spice "$(UUID)"

spice-diff: _require-clone
	@cd "$(FORK_DIR)" && git status --short "$(UUID)" && git diff "$(UUID)"

spice-update: spice-sync spice-validate

spice-commit: _require-clone
	@if [ -z "$(MSG)" ]; then \
		echo "error: pass a message: make spice-commit MSG=\"describe what changed\"" >&2; \
		exit 1; \
	fi
	@cd "$(FORK_DIR)" && git add "$(UUID)" && git commit -m "$(UUID): $(MSG)"

spice-push: _require-clone
	@cd "$(FORK_DIR)" && git push

# The one-command version: sync, validate, commit and push together. Stops
# at the first failure (validate rejecting something, nothing to commit,
# push rejected, ...) rather than pushing a half-finished result - each
# step still runs standalone above if you want to inspect one in between.
spice-publish:
	@if [ -z "$(MSG)" ]; then \
		echo "error: pass a message: make spice-publish MSG=\"describe what changed\"" >&2; \
		exit 1; \
	fi
	$(MAKE) spice-sync
	$(MAKE) spice-validate
	@cd "$(FORK_DIR)" && if [ -z "$$(git status --porcelain -- "$(UUID)")" ]; then \
		echo "Nothing changed since the last sync - nothing to commit or push."; \
	else \
		git add "$(UUID)" && git commit -m "$(UUID): $(MSG)" && git push; \
	fi

# Neither $(FORK_DIR) nor your GitHub fork itself update on their own -
# a fork doesn't auto-track its upstream, and this clone is just a snapshot
# from whenever 'make spice-clone' ran. Three steps to actually keep
# everything current, in order:
#   1. Pull origin/master (fast-forward only) first - your fork on GitHub
#      can easily be ahead of this local clone (pushed from another
#      machine, merged via GitHub's own UI, a previous run that got this
#      far and no further, ...); skipping this and going straight to the
#      push at the end would fail (non-fast-forward) or, worse, need
#      --force and clobber whatever was actually there.
#   2. Add the "upstream" remote if it isn't there yet, fetch linuxmint's
#      real repo, and merge it into local master.
#   3. Push the result back to your own fork on GitHub.
# So the local clone, your fork, and linuxmint's own repo all agree by the
# end. Worth running before a new round of changes, not necessarily every
# single spice-publish - release runs it every time regardless, since it
# has no other chance to notice the local clone drifted.
spice-sync-upstream: _require-clone
	@cd "$(FORK_DIR)" && \
		git pull --ff-only origin master && \
		(git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$(UPSTREAM_REMOTE)") && \
		git fetch upstream && \
		git merge upstream/master -m "Merge upstream/master" && \
		git push origin master

spice-status:
	@if [ -d "$(FORK_DIR)/.git" ]; then \
		echo "Cloned at $(FORK_DIR)"; \
		cd "$(FORK_DIR)" && git status --short "$(UUID)" 2>/dev/null | head -20 || echo "  ($(UUID) not synced into it yet)"; \
	else \
		echo "Not cloned yet - run 'make spice-clone' first."; \
	fi

spice-clean:
	rm -rf "$(FORK_DIR)"

_require-clone:
	@if [ ! -d "$(FORK_DIR)/.git" ]; then \
		echo "error: $(FORK_DIR) doesn't exist yet - run 'make spice-clone' first." >&2; \
		exit 1; \
	fi
