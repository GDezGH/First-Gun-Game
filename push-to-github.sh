#!/usr/bin/env bash
# =============================================================================
# push-to-github.sh — publish this repo to GitHub.
#
#   ./push-to-github.sh <your-github-username> <personal-access-token>
#
# Creates the "First-Gun-Game" repo (private by default) and pushes everything.
# The token is used once and is NOT written into .git/config or any file.
#
# Get a token: GitHub -> Settings -> Developer settings -> Personal access
# tokens -> Fine-grained -> Contents: Read and write, Administration: Read and
# write. Scope it to this one repository.
# =============================================================================
set -euo pipefail

USER="${1:-}"
TOKEN="${2:-}"
REPO="First-Gun-Game"
PRIVATE="${PRIVATE:-true}"

if [[ -z "$USER" || -z "$TOKEN" ]]; then
  echo "usage: ./push-to-github.sh <github-username> <personal-access-token>"
  echo "       PRIVATE=false ./push-to-github.sh <user> <token>   # make it public"
  exit 1
fi

cd "$(dirname "$0")"

# --- commit anything not yet committed --------------------------------------
if [[ -n "$(git status --porcelain)" ]]; then
  git add -A
  git -c user.name="$USER" -c user.email="$USER@users.noreply.github.com" \
      commit -m "Update First Gun Game"
fi

# --- create the repo if it does not exist -----------------------------------
echo "Checking for $USER/$REPO ..."
STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/$USER/$REPO")

if [[ "$STATUS" == "404" ]]; then
  echo "Creating $REPO ..."
  curl -s -X POST -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.github+json" \
    https://api.github.com/user/repos \
    -d "{\"name\":\"$REPO\",\"description\":\"A small arena FPS built with vanilla JavaScript and three.js.\",\"private\":$PRIVATE,\"has_issues\":true}" \
    > /dev/null
  echo "Created."
elif [[ "$STATUS" == "200" ]]; then
  echo "Repo already exists, pushing to it."
else
  echo "GitHub API returned $STATUS. Check the token's scopes." >&2
  exit 1
fi

# --- push (token stays out of the saved remote) ------------------------------
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/$USER/$REPO.git"
git push -u "https://$USER:$TOKEN@github.com/$USER/$REPO.git" HEAD:main
git remote set-url origin "https://github.com/$USER/$REPO.git"

echo
echo "Done -> https://github.com/$USER/$REPO"
