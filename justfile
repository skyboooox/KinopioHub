default:
  @just --list

# Validate repositories.json
validate:
  node scripts/workspace.mjs validate

# Show managed repositories and whether they are cloned
list:
  node scripts/workspace.mjs list

# Clone every missing sibling repository
bootstrap:
  node scripts/workspace.mjs bootstrap

# Show Git status for every repository
status:
  node scripts/workspace.mjs status

# Fetch origin and configured upstream remotes without changing worktrees
fetch:
  node scripts/workspace.mjs fetch

# Fast-forward every clean repository from origin
pull:
  node scripts/workspace.mjs pull

# Set up one repository by id, or every repository with target=all
setup target="all":
  node scripts/workspace.mjs setup "{{target}}"

# Test one repository by id, or every repository with target=all
test target="all":
  node scripts/workspace.mjs test "{{target}}"

# Run the complete cross-repository test set
test-all:
  node scripts/workspace.mjs test all

# Build public Wiki pages from the documentation sources
wiki:
  node scripts/wiki.mjs build

# Check Wiki generation and navigation rewriting
wiki-check:
  node --test scripts/wiki.test.mjs
  node scripts/wiki.mjs build
  node scripts/wiki.mjs check
