default:
  @just --list

# Validate repositories.json
validate:
  python3 scripts/workspace.py validate

# Show managed repositories and whether they are cloned
list:
  python3 scripts/workspace.py list

# Clone every missing sibling repository
bootstrap:
  python3 scripts/workspace.py bootstrap

# Show Git status for every repository
status:
  python3 scripts/workspace.py status

# Fetch origin and configured upstream remotes without changing worktrees
fetch:
  python3 scripts/workspace.py fetch

# Fast-forward every clean repository from origin
pull:
  python3 scripts/workspace.py pull

# Set up one repository by id, or every repository with target=all
setup target="all":
  python3 scripts/workspace.py setup "{{target}}"

# Test one repository by id, or every repository with target=all
test target="all":
  python3 scripts/workspace.py test "{{target}}"

# Run the complete cross-repository test set
test-all:
  python3 scripts/workspace.py test all
